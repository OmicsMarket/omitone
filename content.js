/**
 * 欧米通 - Content Script (ISOLATED world)
 * 作为桥接层：注入主逻辑到页面 + 代理 chrome API 调用
 */
(function () {
  'use strict';

  // ==================== 配置加载 ====================
  let configs = {
    playbackRate: 1.0, muted: false, autoNext: true, enableQuiz: true,
    apiType: 'openai', apiUrl: 'https://api.minimaxi.com', apiKey: '',
    model: 'MiniMax-M2.7', systemPrompt: '',
    retryInterval: 2000, maxRetries: 10, videoCheckInterval: 1000,
    guardNoProgressMs: 7000, guardResumeCooldownMs: 8000, guardMaxResumeWindow: 60000, guardMaxResumes: 3,
  };

  function loadConfig() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'get_config' }, (response) => {
        if (response && !response.error) {
          configs = { ...configs, ...response };
        }
        resolve(configs);
      });
    });
  }

  // 监听配置变化，转发给页面
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.config) {
      configs = { ...configs, ...changes.config.newValue };
      window.postMessage({ type: 'XXT_CONFIG_UPDATED', data: configs }, '*');
    }
  });

  // ==================== postMessage 桥接 ====================
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'xxt_app') return;

    switch (msg.type) {
      case 'get_config':
        window.postMessage({
          source: 'xxt_bridge', id: msg.id, type: 'config_response', data: configs
        }, '*');
        break;

      case 'llm_request':
        chrome.runtime.sendMessage(
          { type: 'llm_request', payload: msg.payload },
          (response) => {
            window.postMessage({
              source: 'xxt_bridge', id: msg.id, type: 'llm_response', data: response
            }, '*');
          }
        );
        break;

      case 'storage_set':
        chrome.storage.local.set(msg.payload);
        break;
    }
  });

  // ==================== 页面脚本注入 ====================
  // page.js 是独立的页面主逻辑文件，可通过 CDN 覆盖更新
  // 在 popup 中配置 pageScriptUrl 即可热更新，无需重装扩展

  function injectPageScript(customUrl) {
    var defaultUrl = chrome.runtime.getURL('page.js');
    var scriptUrl = customUrl || configs.pageScriptUrl || defaultUrl;
    console.log('%c[欧米通] 加载页面脚本: ' + scriptUrl, 'color:#2196F3');

    var script = document.createElement('script');
    script.id = 'xxt-page-script';
    script.src = scriptUrl;
    script.onload = function() {
      console.log('%c[欧米通] Bridge 就绪，页面脚本已注入', 'color:#4CAF50');
    };
    script.onerror = function() {
      console.error('%c[欧米通] 页面脚本加载失败: ' + scriptUrl, 'color:#F44336');
      // 回退到内置版本
      if (scriptUrl !== defaultUrl) {
        console.log('%c回退到内置 page.js', 'color:#FF9800');
        injectPageScript(defaultUrl);
      }
    };
    (document.head || document.documentElement).appendChild(script);
  }

  // 启动：加载配置后注入
  async function start() {
    await loadConfig();
    injectPageScript();
  }

  // 页面加载后注入
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // 监听 popup 的"开始播放"按钮
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'xxt_start') {
      console.log('%c[欧米通] 收到手动启动指令', 'color:#4CAF50');
      // 清理旧的
      var oldPanel = document.getElementById('xxt-panel');
      if (oldPanel) oldPanel.remove();
      // 重新注入
      loadConfig().then(() => injectPageScript());
      sendResponse({ success: true });
    }
    return true;
  });

  // ==================== SPA 导航检测 ====================
  var _lastPageUrl = location.href;

  function onPageChanged() {
    if (location.href === _lastPageUrl) return;
    _lastPageUrl = location.href;
    console.log('%c[欧米通] 检测到页面切换，重新注入', 'color:#FF9800');
    var oldPanel = document.getElementById('xxt-panel');
    if (oldPanel) oldPanel.remove();
    delete window._xxtApp;
    delete window.xxtAI;
    var oldScript = document.getElementById('xxt-page-script');
    if (oldScript) oldScript.remove();
    loadConfig().then(function() { injectPageScript(); });
  }

  // Hook history API
  var _ps = history.pushState;
  history.pushState = function() { _ps.apply(this, arguments); setTimeout(onPageChanged, 500); };
  var _rs = history.replaceState;
  history.replaceState = function() { _rs.apply(this, arguments); setTimeout(onPageChanged, 500); };
  window.addEventListener('popstate', function() { setTimeout(onPageChanged, 500); });
  window.addEventListener('hashchange', function() { setTimeout(onPageChanged, 500); });

  console.log('%c[欧米通] Content Script 已就绪', 'color:#2196F3');
})();

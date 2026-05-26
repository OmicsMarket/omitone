// 默认配置
const DEFAULT_CONFIG = {
  playbackRate: 1.0,
  muted: false,
  autoNext: true,
  enableQuiz: true,
  apiType: 'openai',
  apiUrl: 'https://api.minimaxi.com',
  apiKey: '',
  model: 'MiniMax-M2.7',
  systemPrompt: '',
  pageScriptUrl: '',
  remoteVersionUrl: '',
  maxTokens: 8192
};

// ==================== 远程更新机制 ====================
// 检查远程 page.js 是否有新版本
async function checkForUpdate() {
  const config = await loadConfig();
  if (!config.remoteVersionUrl) return;

  try {
    const resp = await fetch(config.remoteVersionUrl, { cache: 'no-cache' });
    if (!resp.ok) return;
    const remote = await resp.json();
    const newUrl = remote.url || remote.pageScriptUrl;
    const newVersion = remote.version || '';

    if (newUrl && newUrl !== config.pageScriptUrl) {
      console.log('[欧米通] 发现远程更新: ' + newVersion);
      config.pageScriptUrl = newUrl;
      await chrome.storage.local.set({ config });
      // 通知所有 content script 更新
      const tabs = await chrome.tabs.query({ url: '*://*.chaoxing.com/*' });
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'xxt_config_updated', config }).catch(() => {});
      }
    }
  } catch (e) {
    // 静默失败，不影响正常使用
  }
}

// 每天检查一次更新
chrome.alarms.create('checkUpdate', { periodInMinutes: 1440 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkUpdate') checkForUpdate();
});
// 启动时也检查一次
chrome.runtime.onInstalled.addListener(() => { checkForUpdate(); });
chrome.runtime.onStartup.addListener(() => { checkForUpdate(); });

// ==================== 消息处理 ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'llm_request') {
    handleLLMRequest(message.payload).then(sendResponse).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // 保持消息通道开启（异步响应）
  }

  if (message.type === 'get_config') {
    loadConfig().then(sendResponse).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'check_update') {
    checkForUpdate().then(() => sendResponse({ success: true })).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

// 监听配置变化，通知所有学习通页面
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.config) {
    chrome.tabs.query({ url: '*://*.chaoxing.com/*' }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'xxt_config_updated', config: changes.config.newValue }).catch(() => {});
      }
    });
  }
});

// 读取配置（带默认值）
async function loadConfig() {
  const result = await chrome.storage.local.get('config');
  const config = result.config || {};
  // 深度合并默认值
  return { ...DEFAULT_CONFIG, ...config };
}

// 调用 LLM API
async function handleLLMRequest(payload) {
  const { questions } = payload;
  const config = await loadConfig();

  if (!config.apiKey) {
    return { success: false, error: '请先在插件设置中配置 API Key' };
  }

  if (config.apiType === 'claude') {
    return callClaudeAPI(config, questions);
  } else {
    return callOpenAICompatibleAPI(config, questions);
  }
}

// 构建系统提示词
function buildSystemPrompt(config) {
  if (config.systemPrompt) return config.systemPrompt;

  return `你是学习通答题助手。请根据题目选择或填写正确答案。

规则：
1. 单选题：返回选项字母（如 A、B、C、D）
2. 多选题：返回选项字母数组（如 ["A", "C"]）
3. 判断题：返回 "正确" 或 "错误"
4. 填空题：返回要填入的文本
5. 简答题：返回简要答案

请仔细阅读题目和所有选项，选出最正确的答案。
直接输出 JSON 数组，不要思考过程，不要使用 <think> 标签，不要任何解释。`;
}

// 构建发送给 LLM 的题目文本
function buildQuestionsText(questions) {
  return questions.map((q, i) => {
    let text = `题目${i + 1} [类型: ${q.type}]: ${q.title}`;
    if (q.options && q.options.length > 0) {
      text += '\n选项:';
      q.options.forEach((opt, j) => {
        const label = String.fromCharCode(65 + j); // A, B, C, D...
        text += `\n  ${label}. ${opt}`;
      });
    }
    return text;
  }).join('\n\n');
}

// 构建 JSON 输出格式指引
function buildOutputFormat(questions) {
  const formats = questions.map((q, i) => {
    switch (q.type) {
      case 'single':
        return `  {"index": ${i}, "type": "single", "answer": "选项字母"}`;
      case 'multiple':
        return `  {"index": ${i}, "type": "multiple", "answer": ["选项字母1", "选项字母2"]}`;
      case 'judge':
        return `  {"index": ${i}, "type": "judge", "answer": "正确 or 错误"}`;
      case 'fill':
        return `  {"index": ${i}, "type": "fill", "answer": "答案文本"}`;
      case 'short':
        return `  {"index": ${i}, "type": "short", "answer": "答案文本"}`;
      default:
        return `  {"index": ${i}, "type": "${q.type}", "answer": "..."}`;
    }
  });
  return `[\n${formats.join(',\n')}\n]`;
}

// OpenAI 兼容 API 调用
async function callOpenAICompatibleAPI(config, questions) {
  const url = `${config.apiUrl.replace(/\/+$/, '')}/v1/chat/completions`;

  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: buildSystemPrompt(config) },
      {
        role: 'user',
        content: `请回答以下题目。返回格式严格按照 JSON 数组，每个元素包含 index、type、answer 字段。\n\n${buildQuestionsText(questions)}\n\n返回格式示例：\n${buildOutputFormat(questions)}`
      }
    ],
    max_tokens: config.maxTokens,
    temperature: 0.1
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';

  // 尝试解析 JSON（可能被 markdown 代码块包裹）
  return parseLLMResponse(content);
}

// Claude API 调用
async function callClaudeAPI(config, questions) {
  const body = {
    model: config.model,
    max_tokens: config.maxTokens,
    temperature: 0.1,
    system: buildSystemPrompt(config),
    messages: [
      {
        role: 'user',
        content: `请回答以下题目。返回格式严格按照 JSON 数组，每个元素包含 index、type、answer 字段。\n\n${buildQuestionsText(questions)}\n\n返回格式示例：\n${buildOutputFormat(questions)}`
      }
    ]
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claude API 请求失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text || '';

  return parseLLMResponse(content);
}

// 解析 LLM 返回的 JSON（处理 MiniMax think 标签和 markdown 代码块包裹）
function parseLLMResponse(text) {
  // 剥离 MiniMax <think>...</think> 标签
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // 尝试直接解析
  try {
    const data = JSON.parse(cleaned);
    return { success: true, data };
  } catch (e) {
    // 尝试从 markdown 代码块中提取
    const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1].trim());
        return { success: true, data };
      } catch (e2) {
        // 继续尝试其他方式
      }
    }
    // 尝试找到 JSON 数组
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const data = JSON.parse(arrayMatch[0]);
        return { success: true, data };
      } catch (e3) {
        // fall through to error
      }
    }
    return { success: false, error: `无法解析 LLM 返回内容: ${cleaned.substring(0, 200)}` };
  }
}


/**
 * 欧米通 - 页面主逻辑 (MAIN world)
 */
(function() {
  'use strict';

  // 实例 ID，用于阻挡旧实例的 setTimeout 回调干扰新实例
  var _INSTANCE_ID = (window._XXT_UID || 0) + 1;
  window._XXT_UID = _INSTANCE_ID;
  function _isActive() { return window._XXT_UID === _INSTANCE_ID; }

  var $ = window.jQuery;
  if (!$) {
    // Show visible error on page
    var errEl = document.createElement('div');
    errEl.style.cssText = 'position:fixed;top:10px;right:10px;z-index:999999;background:#fff;border:1px solid #ddd;border-radius:6px;padding:12px 16px;font-family:sans-serif;font-size:13px;color:#111;box-shadow:0 2px 12px rgba(0,0,0,.1);';
    errEl.innerHTML = '<b>欧米通</b><br><span style="color:#999;">页面未加载jQuery，无法运行</span>';
    document.body.appendChild(errEl);
    return;
  }

  // ==================== 与 content script 通信 ====================
  var bridgeMsgId = 0;
  var bridgeCallbacks = {};

  function bridgeSend(type, payload) {
    return new Promise(function(resolve) {
      var id = ++bridgeMsgId;
      bridgeCallbacks[id] = resolve;
      window.postMessage({ source: 'xxt_app', id: id, type: type, payload: payload }, '*');
    });
  }

  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.source !== 'xxt_bridge') return;
    if (msg.type === 'config_response' || msg.type === 'llm_response') {
      var cb = bridgeCallbacks[msg.id];
      if (cb) { cb(msg.data); delete bridgeCallbacks[msg.id]; }
    } else if (msg.type === 'XXT_CONFIG_UPDATED') {
      // 配置更新
      if (window._xxtApp) {
        Object.assign(window._xxtApp.configs, msg.data);
        console.log('%c[欧米通] 配置已更新', 'color:#2196F3');
      }
    }
  });

  // ==================== 主应用 ====================
  var app = {
    configs: null,  // 由 bridge 异步填充

    _videoEl: null,
    _treeContainerEl: null,
    _isPlaying: false,
    _checkInterval: null,
    _quizInProgress: false,
    _quizAnswered: false,
    _stepNavigationBound: false,
    _tryTimes: 0,
    _videoRetryCount: 0,
    _videoCount: 0,
    _skipChainCount: 0,
    _currentVideoIndex: 0,
    _stepSwitchAt: 0,
    _lastChapterUrl: '',    // 跟踪页面变化
    _stepSwitchPending: false,
    _delayedNextUnitTimer: null,
    _guardLastTime: 0,
    _guardLastWallTs: 0,
    _guardLastResumeTs: 0,

    _cellData: {
      cells: 0, nCells: 0, currentCellIndex: 0, currentNCellIndex: 0, currentVideoTitle: ''
    },

    // 检查当前实例是否仍然有效（防止旧实例回调干扰新实例）
    _assertActive: function() { return _isActive(); },

    // ==================== 入口 ====================
    run: function() {
      if (!this._assertActive()) return;
      console.log('%c=== 欧米通 启动 ===', 'color:#4CAF50;font-size:16px;font-weight:bold');
      this._getTreeContainer();
      this._initCellData();
      this._videoEl = null;
      this._currentVideoIndex = 0;
      this._videoCount = 0;
      this._videoRetryCount = 0;
      this._skipChainCount = 0;
      this._clearTickLoop();
      this._bindStepNavigation();
      this._startTickLoop();
    },

    // 关闭学习通的确认弹窗（如"有任务点未完成，是否去完成？"）
    _dismissPopups: function() {
      try {
        // 模式1: "去完成"/"继续下一节" 类型弹窗 — 点击"取消"或"继续"
        var btns = document.querySelectorAll('.ans-popbox-btn, .popbox-btn, .dialog-btn, .modal-btn, .popBtn, [class*="pop"] [class*="btn"], .taskDialog .btn, .layui-layer-btn .layui-layer-btn0, .layui-layer-btn1');
        for (var i = 0; i < btns.length; i++) {
          var text = (btns[i].textContent || '').trim();
          if (text.includes('继续') || text.includes('下一节') || text.includes('跳过') || text.includes('取消') || text.includes('关闭') || text.includes('知道了')) {
            btns[i].click();
            console.log('%c关闭弹窗: ' + text, 'color:#FF9800');
            return true;
          }
        }
        // 模式2: layui 弹窗
        var layuiBtn = document.querySelector('.layui-layer-btn .layui-layer-btn0, .layui-layer-btn a');
        if (layuiBtn) { layuiBtn.click(); return true; }
        // 模式3: 关闭按钮
        var closeBtn = document.querySelector('.layui-layer-close, .pop-close, .dialog-close, .modal-close, [class*="close"]');
        if (closeBtn && closeBtn.offsetParent) { closeBtn.click(); return true; }
      } catch(e) {}
      return false;
    },

    // 检测 SPA 页面切换（同一页内 AJAX 导航到新章节）
    _detectPageChange: function() {
      var iframe = document.querySelector('#iframe');
      var newUrl = iframe ? iframe.src : window.location.href;
      // 提取 knowledgeid 或 chapterId
      var idMatch = newUrl.match(/(?:knowledgeid|chapterId)=(\d+)/);
      var newId = idMatch ? idMatch[1] : newUrl;
      if (this._lastChapterUrl && this._lastChapterUrl !== newId) {
        console.log('%c检测到页面切换，重置状态', 'color:#2196F3');
        this._videoEl = null;
        this._isPlaying = false;
        this._quizInProgress = false;
        this._quizAnswered = false;
        this._videoRetryCount = 0;
        this._videoCount = 0;
        this._currentVideoIndex = 0;
        this._clearCheckInterval();
        this._initCellData();
      }
      this._lastChapterUrl = newId;
    },

    // 快速检测：当前章节是否无视频且无测验（可直接跳过）
    _isTextOnly: function() {
      var mainFrame = document.querySelector('#iframe');
      if (!mainFrame || !mainFrame.contentDocument) return true; // 没有主iframe = 空章
      var doc = mainFrame.contentDocument;
      var bodyText = (doc.body && doc.body.innerText) || '';
      bodyText = bodyText.trim();
      if (bodyText.length < 10 || bodyText === '暂无内容') return true;
      // 有视频？→ 不是纯文本
      if (doc.querySelectorAll('video, iframe[src*="video"], iframe[src*="ananas"], .ans-insertvideo-online').length > 0) return false;
      // 有测验？→ 不是纯文本
      if (doc.querySelectorAll('.questionLi, .mark_item, .questionItem, .tiBank, .exam_question, input[type="radio"], input[type="checkbox"]').length > 0) return false;
      // 无视频无测验 → 纯文本，直接跳过
      return true;
    },

    // ==================== 主循环：每2秒检查一次状态 ====================
    _tickLoopInterval: null,

    // 检查当前章节是否有任务点（无任务点的视频直接跳过）
    _hasTaskPoint: function() {
      var mainFrame = document.querySelector('#iframe');
      if (!mainFrame || !mainFrame.contentDocument) return true; // 无法判断，保守处理
      var doc = mainFrame.contentDocument;
      var bodyText = (doc.body && doc.body.innerText) || '';
      // 有任务点标识
      if (bodyText.indexOf('任务点') !== -1) return true;
      // 检查任务点序号标记（圆圈数字）
      var markers = doc.querySelectorAll('.taskPoint, .ans-job-icon, .ans-task-icon, [class*="task"], [class*="job"], .ans-point, .point');
      if (markers.length > 0) return true;
      // 检查页面层的任务点状态
      var pageMarkers = document.querySelectorAll('.catalog_points_er, .catalog_points_san, .catalog_points_yi');
      if (pageMarkers.length > 0) return true;
      // 新版：检查 iframe 中是否有作业/任务序号
      var numEls = doc.querySelectorAll('.ans-job-num, .task-num, [class*="num"], [class*="icon"]');
      for (var i = 0; i < numEls.length; i++) {
        var text = numEls[i].textContent || '';
        if (/^\d+$/.test(text.trim())) return true;
      }
      // 无任务点标识 → 可能是可选视频
      return false;
    },

    // 判断是否为新视频（播放进度 < 5s），新视频才尝试拖动
    // 但有观看时长要求的视频不拖动，必须老实看完
    _shouldTrySkip: function(videoEl) {
      if (!videoEl || videoEl.currentTime >= 5) return false;
      // 检查是否有"完成条件"要求观看时长
      var mf = document.querySelector('#iframe');
      if (mf && mf.contentDocument) {
        var t = (mf.contentDocument.body && mf.contentDocument.body.innerText) || '';
        if (/观看时长\s*[需须≥>]/.test(t) || /完成条件/.test(t)) return false;
      }
      return true;
    },

    // 尝试拖到视频末尾（秒过），成功返回 true

    _trySkipToEnd: async function(videoEl) {
      if (!videoEl) return false;
      try {
        var dur = videoEl.duration;
        // 等待元数据加载
        if (!dur || isNaN(dur)) {
          await new Promise(function(r) {
            var t = setTimeout(function() { r(); }, 3000);
            videoEl.addEventListener('loadedmetadata', function() { clearTimeout(t); r(); }, { once: true });
          });
          dur = videoEl.duration;
        }
        if (!dur || dur < 3 || isNaN(dur)) return false;

        // 反复 seek 到末尾（留 0.5 秒让 ended 自然触发）
        var target = dur - 0.5;
        var attempts = 0;
        while (attempts < 5) {
          videoEl.currentTime = target;
          await new Promise(function(r) { setTimeout(r, 400); });
          if (videoEl.currentTime >= dur - 1) break;
          attempts++;
        }

        // 等 5 秒，看进度条是否被弹回
        await new Promise(function(r) { setTimeout(r, 5000); });
        var finalTime = videoEl.currentTime;
        if (finalTime >= dur - 2 && !videoEl.ended) {
          console.log('%c⏩ 视频可拖动! 停在第' + Math.round(finalTime) + '秒，play后自然结束', 'color:#4CAF50');
          return true;
        }
        if (videoEl.ended) {
          console.log('%c⏩ 视频已结束!', 'color:#4CAF50');
          return true;
        }
        // 被弹回了
        console.log('%c⏩ 视频防拖拽，弹回 (' + Math.round(finalTime) + '/' + Math.round(dur) + 's)，正常播放', 'color:#FF9800');
        return false;
      } catch(e) {
        return false;
      }
    },

    _startTickLoop: function() {
      if (this._tickLoopInterval) return;
      var self = this;
      console.log('%c启动 2秒 轮询循环', 'color:#4CAF50');
      this._tickLoopInterval = setInterval(function() {
        if (!self._assertActive()) { self._clearTickLoop(); return; }
        self._tick();
      }, 2000);
      // 立即执行第一次
      this._tick();
    },

    _clearTickLoop: function() {
      if (this._tickLoopInterval) { clearInterval(this._tickLoopInterval); this._tickLoopInterval = null; }
      this._clearCheckInterval();
    },

    _tick: async function() {
      var self = this;
      try {
        // 1. 检测页面切换
        this._detectPageChange();

        // 2. 检测视频中途弹题（判断题/选择题弹窗）
        var popup = this._checkPopupQuiz();
        if (popup) {
          await this._handlePopupQuiz(popup);
          // 恢复视频播放
          var v2 = this._getVideoEl();
          if (v2 && v2.paused && this._isPlaying) { try { v2.play(); } catch(e) {} }
          return;
        }

        // 3. 如果在播放中，检查播放状态
        if (this._isPlaying) {
          var v = this._getVideoEl();
          if (v && !v.ended) return; // 还在播放，不用管（视频监控 handle）
          if (v && v.ended) {
            console.log('%c视频已结束', 'color:#9C27B0');
            this._isPlaying = false;
            this._clearCheckInterval();
            this.nextUnit();
            return;
          }
          // 视频丢了？重置
          this._isPlaying = false;
          this._clearCheckInterval();
          this._videoEl = null;
        }

        // 3. 尝试找视频
        var el = this._getVideoEl();
        if (el) {
          // 整章无任务点 → 跳过所有视频
          if (!this._hasTaskPoint()) {
            var t2 = document.querySelector('.prev_title');
            console.log('%c无任务点，跳过: ' + ((t2 && (t2.title || t2.textContent)) || '').trim().substring(0, 30), 'color:#607D8B');
            this._dismissPopups();
            this.nextUnit();
            return;
          }
          this._videoRetryCount = 0;
          this._skipChainCount = 0;
          // 1.0.1 稳定版：老老实实正常播放
          this._isPlaying = true;
          el.playbackRate = this.configs.playbackRate;
          if (this.configs.muted) el.muted = true;
          this._videoEventHandle();
          try {
            await el.play();
            var extra = this._videoCount > 1 ? (' [' + (this._currentVideoIndex + 1) + '/' + this._videoCount + ']') : '';
            console.log('%c视频开始播放，倍速: ' + el.playbackRate + 'x' + extra, 'color:#4CAF50');
            this._startVideoMonitoring();
          } catch(e) {
            console.error('播放失败:', e.message);
            this._isPlaying = false;
          }
          return;
        }

        // 4. 找测验
        if (this.configs.enableQuiz && this._detectQuiz()) {
          if (!this.configs.apiKey) {
            console.log('%c检测到章节测验，但未配置API Key，跳过', 'color:#FF9800');
            this._dismissPopups();
            this.nextUnit();
            return;
          }
          this._skipChainCount = 0;
          if (!this._quizAnswered) {
            console.log('%c检测到章节测验，启动AI答题...', 'color:#9C27B0;font-size:14px');
            await this._handleQuiz();
          }
          return;
        }

        // 5. 尝试切到视频步骤
        if (this._advanceLearningStep()) {
          console.log('%c已尝试切到视频步骤', 'color:#607D8B');
          return; // 下次 tick 再检查
        }

        // 6. 已完成的任务跳过（确认无视频无测验后才判定）
        if (this._isCurrentCompleted()) {
          var ct = document.querySelector('.prev_title');
          var cname = ct ? (ct.title || ct.textContent || '').trim().substring(0, 30) : '';
          console.log('%c已完成: ' + cname + '，跳过', 'color:#FF9800');
          this._dismissPopups();
          this.nextUnit();
          return;
        }

        // 7. 无视频无测验未完成 → 纯文本跳过
        this._dismissPopups();
        try {
          var nxtBtn = document.querySelector('#prevNextFocusNext');
          if (nxtBtn) nxtBtn.click();
        } catch(e) {}
        this._skipChainCount++;
        if (this._skipChainCount > 500) {
          console.error('%c连续跳过超过500节，停止', 'color:#F44336;font-weight:bold');
          this._clearTickLoop();
          return;
        }
        var title = (document.querySelector('.prev_title')?.textContent || '').trim().substring(0, 30);
        console.log('%c跳过: ' + title + ' (#' + this._skipChainCount + ')', 'color:#607D8B');
      } catch(e) {
        console.error('tick error:', e);
      }
    },

    _handlePlayError: function(error) {
      var self = this;
      console.error('播放错误详情:', error);
      var video = this._getVideoEl();
      if (video) {
        video.muted = true;
        video.play().then(function() {
          console.log('%c静音播放成功', 'color:#4CAF50');
          if (self._delayedNextUnitTimer) { clearTimeout(self._delayedNextUnitTimer); self._delayedNextUnitTimer = null; }
        }).catch(function(e) {
          console.error('静音播放也失败:', e);
          if (self._delayedNextUnitTimer) clearTimeout(self._delayedNextUnitTimer);
          self._delayedNextUnitTimer = setTimeout(function() { self._delayedNextUnitTimer = null; self.nextUnit(); }, 3000);
        });
      }
    },

    // ==================== 视频保活 ====================
    _startVideoMonitoring: function() {
      this._clearCheckInterval();
      this._guardLastTime = 0;
      this._guardLastWallTs = 0;
      this._guardLastResumeTs = 0;
      var self = this;
      this._checkInterval = setInterval(function() { self._checkVideoStatus(); }, this.configs.videoCheckInterval);
    },

    _clearCheckInterval: function() {
      if (this._checkInterval) { clearInterval(this._checkInterval); this._checkInterval = null; }
    },

    // 检测视频中途弹题（弹窗题/随堂题），有则自动作答或跳过
    _checkPopupQuiz: function() {
      try {
        // 递归搜索所有嵌套 iframe 中的弹窗/弹题
        function searchAll(doc, depth) {
          if (depth > 3) return null;
          var sel = '.ans-pop-quiz, .pop-quiz, .video-quiz, .ans-job-pop, .ans-topic, .vjs-overlay, .ans-attach, .popDiv, .layui-layer, [class*="pop"][class*="quiz"], [class*="question"][class*="pop"]';
          for (var i = 0; i < sel.length; i++) { var el = doc.querySelector(sel[i]); if (el && el.offsetParent && (el.innerText || '').trim().length > 5) return el; }
          var divs = doc.querySelectorAll('div, section');
          for (var j = 0; j < divs.length; j++) {
            if (!divs[j].offsetParent) continue;
            var t = (divs[j].innerText || '').trim();
            if (t.length > 20 && t.length < 600 && /[A-F][、.）)]/.test(t)) {
              var btn = divs[j].querySelector('button, .btn, [class*="submit"], [class*="confirm"], [class*="ans-btn"]');
              if (btn) return divs[j];
            }
          }
          var btns = doc.querySelectorAll('a, button, .btn, [class*="btn"]');
          for (var k = 0; k < btns.length; k++) {
            var txt = (btns[k].textContent || '').trim();
            if ((txt === '知道了' || txt === '关闭' || txt === '确定') && btns[k].offsetParent) return btns[k];
          }
          var iframes = doc.querySelectorAll('iframe');
          for (var f = 0; f < iframes.length; f++) {
            try { var sub = iframes[f].contentDocument || iframes[f].contentWindow.document; if (sub) { var r = searchAll(sub, depth + 1); if (r) return r; } } catch(e) {}
          }
          return null;
        }
        var mf = document.querySelector('#iframe');
        var startDoc = (mf && mf.contentDocument) ? mf.contentDocument : document;
        var popup = searchAll(startDoc, 0);
        if (!popup) popup = searchAll(document, 0);
        if (popup) { var text = (popup.innerText || popup.textContent || '').trim(); if (text.length > 3) console.log('%c检测到弹窗: ' + text.substring(0, 60), 'color:#9C27B0'); return popup; }
        return null;
      } catch(e) { return null; }
    },



    // 处理视频弹题：有 API Key 则 AI 作答，无则尝试关闭
    _handlePopupQuiz: async function(popup) {
      // 如果是"知道了"/"确定"/"关闭"按钮 → 直接点击关闭
      var popText = (popup.textContent || '').trim();
      if (popText === '知道了' || popText === '关闭' || popText === '确定') {
        console.log('%c关闭弹窗: ' + popText, 'color:#FF9800');
        popup.click();
        return;
      }

      var text = (popup.innerText || popup.textContent || '').trim().substring(0, 300);

      // 有 API Key → AI 智能作答
      if (this.configs.enableQuiz && this.configs.apiKey) {
        var type = 'single';
        if (/多选/.test(text)) type = 'multiple';
        if (/判断/.test(text) || /[对错]/.test(text)) type = 'judge';

        var question = { index: 0, type: type, title: text, options: [] };
        var opts = text.match(/[A-F][、.)]\s*([^\n]+)/g);
        if (opts) question.options = opts.map(function(o) { return o.replace(/^[A-F][、.)]\s*/, '').trim(); });

        console.log('%cAI 作答视频弹题', 'color:#9C27B0');
        try {
          var result = await bridgeSend('llm_request', { questions: [question] });
          if (result && result.success && result.data) {
            var answer = Array.isArray(result.data) ? result.data[0] : result.data;
            this._fillPopupAnswer(popup, answer);
            return;
          }
        } catch(e) { console.error('弹题作答失败:', e); }
      }

      // 无 API Key → 默认选 A
      console.log('%c无 API Key，默认选 A', 'color:#FF9800');
      var firstLabel = popup.querySelector('label');
      if (firstLabel) { firstLabel.click(); }
      var submit = popup.querySelector('button, .btn, [class*="submit"], [class*="confirm"]');
      if (submit) submit.click();
    },



    // 填入弹题答案
    _fillPopupAnswer: function(popup, answer) {
      var ans = (typeof answer === 'string') ? answer : (answer.answer || answer.text || String(answer));
      ans = ans.trim();
      // 找选项
      var labels = popup.querySelectorAll('label');
      for (var i = 0; i < labels.length; i++) {
        var text = labels[i].textContent.trim();
        var letter = text.match(/^([A-F])/) || [null, String.fromCharCode(65 + i)];
        if (ans.toUpperCase().indexOf(letter[1]) !== -1 || text.indexOf(ans) !== -1) {
          labels[i].click();
          console.log('  选中弹题选项: ' + text.substring(0, 30));
        }
      }
      // 点提交
      var submit = popup.querySelector('button, .btn, [class*="submit"], [class*="confirm"]');
      if (submit) { submit.click(); console.log('  已提交弹题答案'); }
    },

    _checkVideoStatus: function() {
      try {
        var video = this._getVideoEl();
        if (!video) return;
        if (video.paused && this._isPlaying) {
          console.log('%c检测到视频暂停，尝试恢复播放...', 'color:#FF5722');
          this._tryResumePlayback('paused');
        } else if (this._isPlaying && !video.ended) {
          var now = Date.now();
          var current = Number(video.currentTime || 0);
          if (this._guardLastWallTs === 0) {
            this._guardLastWallTs = now;
            this._guardLastTime = current;
          } else {
            var stalled = Math.abs(current - this._guardLastTime) < 0.01;
            var stalledMs = now - this._guardLastWallTs;
            if (stalled && stalledMs >= this.configs.guardNoProgressMs) {
              this._tryResumePlayback('no-progress');
              this._guardLastWallTs = now;
              this._guardLastTime = Number(video.currentTime || 0);
            } else if (!stalled) {
              this._guardLastWallTs = now;
              this._guardLastTime = current;
            }
          }
        }
        if (video.ended && this._isPlaying) {
          this._isPlaying = false;
          this._clearCheckInterval();
          if (this._videoCount > 1 && this._currentVideoIndex + 1 < this._videoCount) {
            this._currentVideoIndex++;
            this._videoEl = null;
            console.log('%c播放下一个视频 (' + (this._currentVideoIndex + 1) + '/' + this._videoCount + ')', 'color:#2196F3');
            // 让 tick loop 找下一个视频
          } else {
            console.log('%c视频全部播完，切下一节', 'color:#9C27B0');
            var selfY = this;
            setTimeout(function() { selfY.nextUnit(); }, 500);
          }
        }
      } catch (e) {}
    },

    _tryResumePlayback: function(reason) {
      var now = Date.now();
      if (now - this._guardLastResumeTs < this.configs.guardResumeCooldownMs) return;

      // Backoff: if too many resumes in a short window, stop fighting the platform
      if (!this._resumeWindowStart || now - this._resumeWindowStart > this.configs.guardMaxResumeWindow) {
        this._resumeWindowStart = now;
        this._resumeAttemptCount = 0;
      }
      if (this._resumeAttemptCount >= this.configs.guardMaxResumes) {
        console.log('%c恢复次数过多，可能平台在干预，暂停恢复', 'color:#FF9800');
        return;
      }
      this._resumeAttemptCount++;
      this._guardLastResumeTs = now;

      var video = this._getVideoEl();
      if (!video || !this._isPlaying) return;
      console.log('%c触发视频保活恢复(' + reason + ')', 'color:#607D8B');
      video.play().catch(function(e) {
        console.warn('直接恢复播放失败，尝试静音恢复:', e);
        video.muted = true;
        video.play().catch(function(err) { console.error('静音恢复播放失败:', err); });
      });
    },

    // ==================== 课程导航 ====================
    nextUnit: function() {
      if (!this._assertActive()) return;
      if (!this.configs.autoNext) { console.log('%c自动下一节已关闭', 'color:#FF9800'); return; }
      console.log('%c=== 切换到下一节 ===', 'color:#2196F3');
      // 简单粗暴：点下一节按钮，让 tick loop 接管后续
      this._dismissPopups();
      try {
        var nxt = document.querySelector('#prevNextFocusNext');
        if (nxt) nxt.click();
      } catch(e) {}
      // 重置状态
      this._videoEl = null;
      this._isPlaying = false;
      this._currentVideoIndex = 0;
      this._videoCount = 0;
      this._clearCheckInterval();
    },

    playCurrentIndex: function(nCell) {
      var self = this;
      if (!nCell) {
        var el = this._getTreeContainer();
        var cells = el.children('ul').children('li');
        var nCells = $(cells.get(this._cellData.currentCellIndex)).find('.posCatalog_select:not(.firstLayer)');
        nCell = nCells.get(this._cellData.currentNCellIndex);
      }
      var clickableSpan = $(nCell).find('.posCatalog_name')[0];
      if (!clickableSpan) {
        console.error('%c===========找不到可点击的课程节点==============', 'color:#F44336');
        setTimeout(function() { self.nextUnit(); }, 2000);
        return;
      }
      console.log('%c点击切换到: ' + ($(clickableSpan).attr('title') || '未知标题'), 'color:#2196F3');
      $(clickableSpan).click();
      this._videoEl = null;
      this._isPlaying = false;
      this._currentVideoIndex = 0;
      this._videoCount = 0;
      this._videoRetryCount = 0;
      this._skipChainCount = 0;
      this._quizInProgress = false;
      this._quizAnswered = false;
      console.log('%c等待视频加载...', 'color:#FF9800');
      setTimeout(function() { self._initCellData(); if (self._skipIfCompleted()) return; self.play(); }, 3000);
    },

    // 检查当前节是否已完成
    _isCurrentCompleted: function() {
      // 方法1: 课程树中当前激活项的完成标记
      var active = document.querySelector('.posCatalog_active');
      if (active) {
        if (active.querySelector('.icon_Completed, .icon_completed, [class*="completed"], [class*="finish"]')) return true;
      }
      // 方法2: 查找绿色完成图标（新版学习通）
      var greenIcon = document.querySelector('.prev_title .icon_Completed, .prev_title [style*="green"], .catalog_points_yi');
      if (greenIcon) return true;
      // 方法3: 任务点显示为绿色/完成状态
      var taskPoints = document.querySelectorAll('.catalog_points_yi, .catalog_points_er, .catalog_points_san');
      for (var i = 0; i < taskPoints.length; i++) {
        var style = taskPoints[i].getAttribute('style') || '';
        if (style.indexOf('green') !== -1 || style.indexOf('#00') !== -1 || style.indexOf('rgb(0,') !== -1) return true;
      }
      // 方法4: iframe 内容页面中的完成提示
      var mainFrame = document.querySelector('#iframe');
      if (mainFrame && mainFrame.contentDocument) {
        var body = mainFrame.contentDocument.body;
        if (body && (body.innerText || '').indexOf('已完成') !== -1) {
          // 确认不是"已完成任务点"这种总结信息
          var completedEl = mainFrame.contentDocument.querySelector('.complete, .finished, [class*="complete"], [class*="finish"]');
          if (completedEl) return true;
        }
      }
      return false;
    },

    // ==================== 学习步骤导航 ====================
    _advanceLearningStep: function() {
      if (this._stepSwitchPending && Date.now() - this._stepSwitchAt < 4000) return true;
      var prevTitle = document.getElementsByClassName('prev_title')[0];
      var title = prevTitle ? (prevTitle.title || prevTitle.textContent || '').trim() : '';
      if (title === '章节测验' || title === '视频') return false;
      var self = this;
      var videoTab = $('.prev_white:visible').filter(function(_, el) {
        var text = ($(el).text() || '').replace(/\\s+/g, '');
        return text === '2视频' || text === '视频';
      }).get(0);
      if (videoTab) {
        this._stepSwitchPending = true;
        this._stepSwitchAt = Date.now();
        console.log('%c尝试点击"视频"页签', 'color:#2196F3');
        videoTab.click();
        return true;
      }
      return false;
    },

    _bindStepNavigation: function() {
      if (this._stepNavigationBound) return;
      this._stepNavigationBound = true;
      var self = this;
      $(document).on('click', '.prev_white', function(e) {
        var text = ($(e.currentTarget).text() || '').replace(/\\s+/g, '');
        if (text.includes('视频')) {
          console.log('%c检测到步骤切换点击：' + text + '，准备重新接管视频页', 'color:#607D8B');
          self._videoEl = null;
          self._isPlaying = false;
          self._quizInProgress = false;
          self._quizAnswered = false;
          self._stepSwitchPending = true;
          self._stepSwitchAt = Date.now();
          setTimeout(function() { try { self._initCellData(); } catch(err) {} self.play(); }, 1800);
        }
      });
    },

    // ==================== 课程数据 ====================
    _initCellData: function() {
      var el = this._getTreeContainer();
      var cells = el.children('ul').children('li');
      this._cellData.cells = cells.length;
      var nCellCounts = 0;
      var foundCurrent = false;
      var self = this;
      cells.each(function(i, v) {
        var nCells = $(v).find('.posCatalog_select:not(.firstLayer)');
        nCellCounts += nCells.length;
        nCells.each(function(j, e) {
          var _el = $(e);
          if (_el.hasClass('posCatalog_active')) {
            self._cellData.currentCellIndex = i;
            self._cellData.currentNCellIndex = j;
            foundCurrent = true;
            var titleSpan = _el.find('.posCatalog_name')[0];
            if (titleSpan) self._cellData.currentVideoTitle = $(titleSpan).attr('title') || '';
          }
        });
      });
      this._cellData.nCells = nCellCounts;
      if (!foundCurrent && nCellCounts > 0) {
        console.warn('%c未找到当前激活的视频节点，可能需要手动选择', 'color:#FF9800');
      }
      console.log('%c课程信息: ' + this._cellData.cells + '章, ' + this._cellData.nCells + '节, 当前: 第' + (this._cellData.currentCellIndex+1) + '章第' + (this._cellData.currentNCellIndex+1) + '节', 'color:#607D8B');
    },

    _getTreeContainer: function() {
      if (!this._treeContainerEl) {
        var el = $('#coursetree');
        if (el.length <= 0) throw new Error('找不到视频列表 #coursetree');
        this._treeContainerEl = el;
      }
      return this._treeContainerEl;
    },

    _getVideoEl: function(index) {
      var idx = (typeof index === 'number') ? index : this._currentVideoIndex;
      if (!this._videoEl) {
        try {
          // 多种方式查找视频 iframe
          var frameObj = null;
          // 递归搜索所有 iframe 找到所有 video 元素
          function findVids(doc, depth) {
            if (depth > 3) return [];
            var vids = [];
            var dv = doc.querySelectorAll('video');
            for (var v = 0; v < dv.length; v++) vids.push(dv[v]);
            var fs = doc.querySelectorAll('iframe');
            for (var i = 0; i < fs.length; i++) {
              try {
                var sd = fs[i].contentDocument || fs[i].contentWindow.document;
                if (sd) { var sv = findVids(sd, depth + 1); for (var s = 0; s < sv.length; s++) vids.push(sv[s]); }
              } catch (e) {}
            }
            return vids;
          }
          var allVids = [];
          var mf = document.querySelector('#iframe');
          if (mf && mf.contentDocument) { try { allVids = findVids(mf.contentDocument, 0); } catch (e) {} }
          if (allVids.length === 0) allVids = findVids(document, 0);
          if (allVids.length === 0) return null;
          this._videoCount = allVids.length;
          if (idx < allVids.length) this._videoEl = allVids[idx];
        } catch (e) { return null; }
      }
      if (!this._videoEl) return null;
      return this._videoEl;
    },

    // ==================== 视频事件 ====================
    _videoEventHandle: function() {
      var el = this._videoEl;
      if (!el) return;
      try {
        el.removeEventListener('ended', this._onVideoEnded);
        el.removeEventListener('loadedmetadata', this._onVideoLoaded);
        el.removeEventListener('play', this._onVideoPlay);
        el.removeEventListener('pause', this._onVideoPause);
      } catch(e) {}
      this._onVideoEnded = this._handleVideoEnded.bind(this);
      this._onVideoLoaded = this._handleVideoLoaded.bind(this);
      this._onVideoPlay = this._handleVideoPlay.bind(this);
      this._onVideoPause = this._handleVideoPause.bind(this);
      el.addEventListener('ended', this._onVideoEnded);
      el.addEventListener('loadedmetadata', this._onVideoLoaded);
      el.addEventListener('play', this._onVideoPlay);
      el.addEventListener('pause', this._onVideoPause);
    },

    _handleVideoEnded: function(e) {
      var title = this._cellData.currentVideoTitle;
      var extra = this._videoCount > 1 ? (' [' + (this._currentVideoIndex + 1) + '/' + this._videoCount + ']') : '';
      console.warn('%c============' + title + ' 播放完成' + extra + '=============', 'color:#4CAF50;font-weight:bold');
      this._isPlaying = false;
      this._clearCheckInterval();
      if (!this.configs.autoNext) return;
      // 检查当前小节是否还有更多视频
      if (this._videoCount > 1 && this._currentVideoIndex + 1 < this._videoCount) {
        this._currentVideoIndex++;
        this._videoEl = null;
        console.log('%c下一个视频 (' + (this._currentVideoIndex + 1) + '/' + this._videoCount + ')，tick loop 接管', 'color:#2196F3');
        // tick loop 会在下次轮询时自动找到新视频
        return;
      }
      // 当前小节所有视频已播完，跳下一节
      var self = this;
      setTimeout(function() { self.nextUnit(); }, 500);
    },

    _handleVideoLoaded: function(e) {
      console.log('%c============视频加载完成=============', 'color:#2196F3');
      // tick loop 会自动处理
    },

    _handleVideoPlay: function(e) {
      var title = this._cellData.currentVideoTitle;
      console.info('%c============' + title + ' 开始播放=============', 'color:#4CAF50');
      this._isPlaying = true;
      this._stepSwitchPending = false;
      var video = this._getVideoEl();
      this._guardLastTime = Number((video && video.currentTime) || 0);
      this._guardLastWallTs = Date.now();
      this._resumeWindowStart = 0;
      this._resumeAttemptCount = 0;
      if (this._delayedNextUnitTimer) { clearTimeout(this._delayedNextUnitTimer); this._delayedNextUnitTimer = null; }
    },

    _handleVideoPause: function(e) {
      console.log('%c============视频暂停=============', 'color:#FF9800');
    },

    // ==================== 章节测验答题模块 ====================
    _detectQuiz: function() {
      var prevTitle = document.querySelector('.prev_title');
      if (prevTitle) {
        var title = (prevTitle.title || prevTitle.textContent || '').trim();
        if (title.includes('章节测验') || title.includes('作业') || title.includes('考试')) return true;
      }
      var quizSelectors = ['.questionLi','.questionItem','.tiBank','.topicItem','.exam_question','.question-content','.singleQues','.mark_item','.questionBox','.answerOption'];
      for (var i = 0; i < quizSelectors.length; i++) {
        if (document.querySelector(quizSelectors[i])) return true;
      }
      try {
        var iframes = document.querySelectorAll('iframe');
        for (var j = 0; j < iframes.length; j++) {
          try {
            var doc = iframes[j].contentDocument || iframes[j].contentWindow.document;
            if (doc) {
              for (var k = 0; k < quizSelectors.length; k++) {
                if (doc.querySelector(quizSelectors[k])) return true;
              }
            }
          } catch(e) {}
        }
      } catch(e) {}
      return false;
    },

    _skipQuiz: function() {
      var self = this;
      console.log('%c跳过章节测验，2秒后继续...', 'color:#607D8B');
      try {
        var nxtBtn = document.querySelector('#prevNextFocusNext');
        if (nxtBtn) nxtBtn.click();
      } catch(e) {}
      this._quizInProgress = false;
      this._quizAnswered = false;
      setTimeout(function() { self.play(); }, 2000);
    },

    _handleQuiz: async function() {
      if (this._quizAnswered) { console.log('%c本次测验已答题，跳过', 'color:#607D8B'); this._skipQuiz(); return; }
      this._quizInProgress = true;
      var questions = this._extractQuestions();
      if (questions.length === 0) { console.warn('%c未提取到题目，尝试跳过', 'color:#FF9800'); this._skipQuiz(); return; }
      console.log('%c成功提取 ' + questions.length + ' 道题目', 'color:#4CAF50');
      console.log(questions);
      try {
        console.log('%c正在调用AI大模型答题...', 'color:#9C27B0;font-size:14px');
        var result = await bridgeSend('llm_request', { questions: questions.map(function(q) { return { index: q.index, type: q.type, title: q.title, options: q.options }; }) });
        if (!result || !result.success) {
          console.error('%cAI答题失败: ' + (result ? result.error : '未知错误'), 'color:#F44336');
          return;
        }
        var answers = result.data;
        if (Array.isArray(answers)) {
          console.log('%cAI返回答案:', 'color:#4CAF50', answers);
          this._fillAnswers(answers, questions);
          this._quizAnswered = true;
        } else if (answers && Array.isArray(answers.answers)) {
          console.log('%cAI返回答案:', 'color:#4CAF50', answers.answers);
          this._fillAnswers(answers.answers, questions);
          this._quizAnswered = true;
        }
      } catch(e) {
        console.error('%cAI答题异常:', 'color:#F44336', e);
      }
    },

    _extractQuestions: function() {
      var main = this._extractFromDocument(document);
      if (main.length > 0) return main;
      try {
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try {
            var doc = iframes[i].contentDocument || iframes[i].contentWindow.document;
            if (doc) {
              var frameQuestions = this._extractFromDocument(doc);
              if (frameQuestions.length > 0) {
                for (var j = 0; j < frameQuestions.length; j++) { frameQuestions[j]._inIframe = true; frameQuestions[j]._iframe = iframes[i]; }
                return frameQuestions;
              }
            }
          } catch(e) {}
        }
      } catch(e) {}
      return [];
    },

    _extractFromDocument: function(doc) {
      var questions = [];
      var containerSelectors = ['.questionLi','.questionItem','.topicItem','.exam_question','.singleQues','.mark_item','.questionBox','li.quesLi','div[class*="question"]','div[class*="topic"]'];
      var containers = [];
      for (var i = 0; i < containerSelectors.length; i++) {
        var found = doc.querySelectorAll(containerSelectors[i]);
        if (found.length > 0) { containers = found; break; }
      }
      if (containers.length === 0) containers = doc.querySelectorAll('.mark_item, .questionLi, .tiBank');
      var self = this;
      containers.forEach(function(container, index) {
        var q = self._parseQuestionElement(container, index);
        if (q) questions.push(q);
      });
      return questions;
    },

    _parseQuestionElement: function(el, index) {
      var title = '';
      var titleSelectors = ['.question-title','.topicTitle','.question_content','.qContent','.mark_title','.question-name','.title','h3','h4','.stem','[class*="question"]','[class*="title"]'];
      for (var i = 0; i < titleSelectors.length; i++) {
        var titleEl = el.querySelector(titleSelectors[i]);
        if (titleEl && titleEl.textContent.trim()) { title = titleEl.textContent.trim(); break; }
      }
      if (!title) title = el.textContent.trim().substring(0, 200);
      title = title.replace(/^\\d+[.、)\\s]+/, '').trim();
      var options = [];
      var labels = el.querySelectorAll('label');
      if (labels.length >= 2) {
        labels.forEach(function(label) {
          var text = label.textContent.trim();
          if (text && text.length < 500) {
            var cleaned = text.replace(/^[A-F][.、)\\s]+/, '').trim();
            if (cleaned && options.indexOf(cleaned) === -1) options.push(cleaned);
          }
        });
      }
      var type = this._detectQuestionType(el);
      return { index: index, type: type, title: title, options: options, _element: el };
    },

    _detectQuestionType: function(el) {
      var text = el.textContent || '';
      var radios = el.querySelectorAll('input[type="radio"]');
      var checkboxes = el.querySelectorAll('input[type="checkbox"]');
      var textInputs = el.querySelectorAll('input[type="text"], input:not([type])');
      var textareas = el.querySelectorAll('textarea');
      if (radios.length === 2) {
        var optionTexts = [];
        var labelEls = el.querySelectorAll('label');
        for (var i = 0; i < labelEls.length; i++) optionTexts.push(labelEls[i].textContent.trim());
        var keywords = ['正确','错误','对','错','√','×','是','否','true','false'];
        var matchCount = 0;
        for (var j = 0; j < optionTexts.length; j++) {
          for (var k = 0; k < keywords.length; k++) {
            if (optionTexts[j].indexOf(keywords[k]) !== -1) { matchCount++; break; }
          }
        }
        if (matchCount >= 1 && radios.length === 2) return 'judge';
      }
      if (checkboxes.length >= 2) return 'multiple';
      if (textInputs.length >= 1 && checkboxes.length === 0 && radios.length === 0) return 'fill';
      if (textareas.length >= 1 && radios.length === 0 && checkboxes.length === 0) return 'short';
      if (radios.length >= 2) return 'single';
      if (text.indexOf('多选') !== -1 || text.indexOf('多选题') !== -1) return 'multiple';
      if (text.indexOf('判断') !== -1 || text.indexOf('对错') !== -1) return 'judge';
      if (text.indexOf('填空') !== -1) return 'fill';
      if (text.indexOf('简答') !== -1 || text.indexOf('问答') !== -1) return 'short';
      return 'single';
    },

    _fillAnswers: function(answers, questions) {
      var self = this;

      // Normalize: handle both structured [{index, type, answer}] and flat ["A", "B", "正确"]
      var normalized = [];
      answers.forEach(function(item, i) {
        if (typeof item === 'object' && item !== null && item.answer !== undefined) {
          // Structured format: {index, type, answer}
          normalized.push({ index: item.index != null ? item.index : i, type: item.type, answer: item.answer });
        } else if (typeof item === 'object' && item !== null && Array.isArray(item.answers)) {
          // Wrapped format: {answers: [...]}
          item.answers.forEach(function(a) { normalized.push(a); });
        } else {
          // Flat format: string or object with just answer
          var answerText = typeof item === 'string' ? item : (item.answer || item.text || item.value || String(item));
          var question = questions[i];
          normalized.push({ index: i, type: question ? question.type : 'single', answer: answerText });
        }
      });

      normalized.forEach(function(answerItem) {
        var question = questions[answerItem.index];
        if (!question) { console.warn('答案索引 ' + answerItem.index + ' 找不到对应题目'); return; }
        var el = question._element;
        if (!el) return;
        console.log('%c填写第' + (answerItem.index+1) + '题: ' + answerItem.answer, 'color:#4CAF50');
        switch (answerItem.type || question.type) {
          case 'single': case 'judge': self._fillChoice(el, answerItem.answer, 'radio'); break;
          case 'multiple': self._fillMultiChoice(el, answerItem.answer); break;
          case 'fill': self._fillText(el, answerItem.answer); break;
          case 'short': self._fillTextarea(el, answerItem.answer); break;
        }
      });
      console.log('%c全部答案已填入！请检查无误后手动提交。', 'color:#4CAF50;font-size:14px;font-weight:bold');
    },

    _fillChoice: function(el, answer, inputType) {
      var labels = el.querySelectorAll('label');
      var answerStr = typeof answer === 'string' ? answer.trim() : '';
      var targetLetter = answerStr.toUpperCase();
      var targetText = answerStr;
      var matched = false;

      // Pass 1: try exact letter match (e.g., answer="A" matches "A. xxx")
      if (!matched) {
        labels.forEach(function(label, i) {
          var text = label.textContent.trim();
          var match = text.match(/^([A-F])[.、)\\s]/);
          var letter = match ? match[1] : String.fromCharCode(65 + i);
          if (letter === targetLetter && targetLetter.length === 1) {
            var input = label.querySelector('input[type="' + inputType + '"]');
            if (input) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); }
            label.click();
            console.log('  选中: ' + text.substring(0, 30));
            matched = true;
          }
        });
      }

      // Pass 2: fallback — match by answer text content in label (e.g., answer="毛泽东思想" matches "A. 毛泽东思想")
      if (!matched) {
        for (var i = 0; i < labels.length; i++) {
          var text = labels[i].textContent.trim();
          var cleaned = text.replace(/^[A-F][.、)\\s]+/, '').trim();
          if (cleaned === targetText || cleaned.includes(targetText) || targetText.includes(cleaned)) {
            var input = labels[i].querySelector('input[type="' + inputType + '"]');
            if (input) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); }
            labels[i].click();
            console.log('  选中(text): ' + text.substring(0, 30));
            matched = true;
            break;
          }
        }
      }
    },

    _fillMultiChoice: function(el, answers) {
      if (!Array.isArray(answers)) return;
      var labels = el.querySelectorAll('label');
      var targets = answers.map(function(a) { return String(a).trim().toUpperCase(); });
      labels.forEach(function(label, i) {
        var text = label.textContent.trim();
        var match = text.match(/^([A-F])[.、)\\s]/);
        var letter = match ? match[1] : String.fromCharCode(65 + i);
        if (targets.indexOf(letter) !== -1) {
          var input = label.querySelector('input[type="checkbox"]');
          if (input) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); }
          label.click();
          console.log('  选中: ' + text.substring(0, 30));
        }
      });
    },

    _fillText: function(el, answer) {
      var text = String(answer);
      var input = el.querySelector('input[type="text"], input:not([type])');
      if (input) {
        var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (nativeSetter && nativeSetter.set) nativeSetter.set.call(input, text);
        else input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('  填入: ' + text);
      }
    },

    _fillTextarea: function(el, answer) {
      var text = String(answer);
      var textarea = el.querySelector('textarea');
      if (textarea) {
        var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        if (nativeSetter && nativeSetter.set) nativeSetter.set.call(textarea, text);
        else textarea.value = text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('  填入: ' + text.substring(0, 50) + '...');
      }
    }
  };

  // ==================== 启动面板 ====================
  function showStartPanel(config) {
    // Remove any existing panel
    var oldPanel = document.getElementById('xxt-panel');
    if (oldPanel) oldPanel.remove();

    var hasApiKey = !!(config.apiKey && config.apiKey.trim());
    var autoPlay = config.autoNext !== false;
    var autoAnswer = config.enableQuiz && hasApiKey;

    // Create floating panel
    var panel = document.createElement('div');
    panel.id = 'xxt-panel';
    panel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;' +
      'background:#fff;border:1px solid #ddd;border-radius:8px;padding:24px 28px;' +
      'box-shadow:0 4px 24px rgba(0,0,0,.12);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;' +
      'font-size:13px;color:#111;min-width:280px;';

    var title = '欧米通';

    panel.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:20px;">' +
        '<div style="width:6px;height:6px;background:#111;border-radius:50%;"></div>' +
        '<span style="font-size:14px;font-weight:600;">' + title + '</span>' +
      '</div>' +

      '<div id="xxt-row-play" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0f0f0;cursor:pointer;">' +
        '<span>自动连播</span>' +
        '<div id="xxt-tg-play" style="width:36px;height:20px;background:' + (autoPlay ? '#111' : '#ddd') + ';border-radius:20px;position:relative;transition:background .15s;">' +
          '<div style="width:16px;height:16px;background:#fff;border-radius:50%;position:absolute;top:2px;left:' + (autoPlay ? '18px' : '2px') + ';transition:left .15s;"></div>' +
        '</div>' +
      '</div>' +

      '<div id="xxt-row-quiz" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0f0f0;' + (hasApiKey ? 'cursor:pointer;' : 'opacity:.4;') + '">' +
        '<span>自动答题</span>' +
        (hasApiKey ?
          '<div id="xxt-tg-quiz" style="width:36px;height:20px;background:' + (autoAnswer ? '#111' : '#ddd') + ';border-radius:20px;position:relative;transition:background .15s;">' +
            '<div style="width:16px;height:16px;background:#fff;border-radius:50%;position:absolute;top:2px;left:' + (autoAnswer ? '18px' : '2px') + ';transition:left .15s;"></div>' +
          '</div>'
        : '<span style="font-size:11px;color:#999;">需配置API</span>') +
      '</div>' +

      '<button id="xxt-btn-start" style="width:100%;margin-top:16px;padding:10px 0;background:#111;color:#fff;border:none;' +
        'border-radius:4px;font-size:13px;font-weight:600;cursor:pointer;">开始</button>' +
      '<button id="xxt-btn-close" style="width:100%;margin-top:6px;padding:8px 0;background:transparent;color:#999;border:1px solid #eee;' +
        'border-radius:4px;font-size:12px;cursor:pointer;">关闭</button>';

    document.body.appendChild(panel);

    // State
    var playOn = autoPlay;
    var quizOn = autoAnswer;

    function updatePlay() {
      var tg = document.getElementById('xxt-tg-play');
      if (!tg) return;
      tg.style.background = playOn ? '#111' : '#ddd';
      tg.children[0].style.left = playOn ? '18px' : '2px';
    }
    function updateQuiz() {
      var tg = document.getElementById('xxt-tg-quiz');
      if (!tg) return;
      tg.style.background = quizOn ? '#111' : '#ddd';
      if (tg.children[0]) tg.children[0].style.left = quizOn ? '18px' : '2px';
    }

    // Toggle handlers
    document.getElementById('xxt-row-play').addEventListener('click', function() { playOn = !playOn; updatePlay(); });
    if (hasApiKey) {
      document.getElementById('xxt-row-quiz').addEventListener('click', function() { quizOn = !quizOn; updateQuiz(); });
    }

    // Start button
    document.getElementById('xxt-btn-start').addEventListener('click', function() {
      panel.remove();
      app.configs.autoNext = playOn;
      app.configs.enableQuiz = quizOn && hasApiKey;
      console.log('%c自动连播: ' + (playOn ? '开' : '关') + ' | 自动答题: ' + ((quizOn && hasApiKey) ? '开' : '关'), 'color:#4CAF50');
      app.run();
      window._xxtApp = app;
    });

    // Close button
    document.getElementById('xxt-btn-close').addEventListener('click', function() {
      panel.remove();
      app.configs.autoNext = false;
      app.configs.enableQuiz = false;
      console.log('%c已关闭助手面板', 'color:#999');
      window._xxtApp = app;
    });
  }

  // ==================== 启动 ====================
  // 立即用默认配置显示面板，不等待异步加载
  var defaultConfig = { apiKey: '', autoNext: true, enableQuiz: false };
  app.configs = defaultConfig;
  window._xxtApp = app;
  showStartPanel(defaultConfig);

  // 异步加载真实配置，加载后更新面板
  bridgeSend('get_config').then(function(config) {
    app.configs = config || defaultConfig;
    // 移除旧面板，用真实配置重建
    var oldPanel = document.getElementById('xxt-panel');
    if (oldPanel) oldPanel.remove();
    showStartPanel(config || defaultConfig);
  });

  // ==================== 后台保活 ====================
  var preventPause = function(e) { e.stopPropagation(); e.preventDefault(); };
  var resumePlaybackNow = function() { if (app && typeof app._tryResumePlayback === 'function') app._tryResumePlayback('page-event'); };
  document.addEventListener('mouseleave', preventPause);
  window.addEventListener('mouseleave', preventPause);
  document.addEventListener('mouseout', preventPause);
  window.addEventListener('mouseout', preventPause);
  window.addEventListener('blur', function() { console.log('%c页面失去焦点，保持播放状态', 'color:#607D8B'); resumePlaybackNow(); });
  document.addEventListener('visibilitychange', function() { if (document.hidden) console.log('%c页面切到后台，尝试保持播放状态', 'color:#607D8B'); resumePlaybackNow(); });

  // 暴露调试接口
  window.xxtAI = {
    reload: function() { bridgeSend('get_config').then(function(c) { app.configs = c; showStartPanel(c); }); },
    next: function() { app && app.nextUnit(); },
    skipQuiz: function() { app && app._skipQuiz(); },
  };
  console.log('%c[欧米通] 页面脚本已加载，等待配置...', 'color:#2196F3');
})();

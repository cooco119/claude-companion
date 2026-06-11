/* 클로드 컴패니언 — 프런트 (vanilla JS, 빌드 없음) */
(function () {
  'use strict';

  // ---------- 공통 유틸 ----------

  var $ = function (sel) { return document.querySelector(sel); };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // 마크다운 → HTML 렌더. 모델 출력/레슨 등 신뢰할 수 없는 내용이 들어오므로
  // marked 결과를 반드시 DOMPurify로 소독(sanitize)한 뒤에만 innerHTML에 넣는다 (XSS 방지).
  // DOMPurify를 못 불러온 경우(CDN 차단 등)에는 HTML 렌더를 포기하고 일반 텍스트로 보여준다.
  function renderMarkdown(target, markdown) {
    try {
      if (typeof DOMPurify === 'undefined' || !DOMPurify.sanitize) {
        target.textContent = markdown || '';
        return;
      }
      target.innerHTML = DOMPurify.sanitize(marked.parse(markdown || ''));
    } catch (e) {
      target.textContent = markdown || '';
    }
  }

  // ~/.claude/projects의 인코딩된 디렉터리명('-Users-hong-Desktop-my-folder' 식)을
  // 사람이 읽을 수 있는 이름(마지막 폴더명)으로 바꾼다.
  function humanizeProject(project) {
    if (!project) return '';
    var parts = String(project).split('-').filter(function (p) { return p !== ''; });
    if (parts.length === 0) return String(project);
    return parts[parts.length - 1];
  }

  // 호출 비용(USD)을 작은 안내 문구로 덧붙인다 (레슨 6의 '비용 이야기'와 일치하도록 UI에 표시).
  function appendCostNote(containerEl, costUsd) {
    if (typeof costUsd !== 'number' || !(costUsd > 0)) return;
    containerEl.appendChild(el('div', 'msg-cost', '💲 이번 호출 비용: 약 $' + costUsd.toFixed(4)));
  }

  function timeAgo(input) {
    var t = typeof input === 'number' ? input : Date.parse(input);
    if (isNaN(t)) return '';
    var diff = Date.now() - t;
    var min = Math.floor(diff / 60000);
    if (min < 1) return '방금 전';
    if (min < 60) return min + '분 전';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + '시간 전';
    var day = Math.floor(hr / 24);
    if (day < 30) return day + '일 전';
    var d = new Date(t);
    return d.getFullYear() + '.' + (d.getMonth() + 1) + '.' + d.getDate();
  }

  // fetch 래퍼: 네트워크 실패/HTTP 에러를 한국어 메시지로 변환
  function api(path, options) {
    return fetch(path, options).then(
      function (res) {
        return res.json().catch(function () {
          return null;
        }).then(function (body) {
          if (!res.ok) {
            var msg = (body && body.error) ? body.error
              : '서버에서 오류가 발생했어요. (코드 ' + res.status + ') 잠시 후 다시 시도해 주세요.';
            throw new Error(msg);
          }
          if (body == null) {
            throw new Error('서버 응답을 이해하지 못했어요. 잠시 후 다시 시도해 주세요.');
          }
          return body;
        });
      },
      function () {
        throw new Error('서버에 연결할 수 없어요. 앱이 켜져 있는지 확인해 주세요. (터미널에서 npm start)');
      }
    );
  }

  function apiPost(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  function showError(boxEl, message) {
    boxEl.textContent = message;
    boxEl.classList.remove('hidden');
  }

  function hideError(boxEl) {
    boxEl.classList.add('hidden');
  }

  // ---------- 탭 전환 ----------

  var tabButtons = document.querySelectorAll('.tab-btn');
  tabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      tabButtons.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
      $('#view-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'learn') loadLessons();
      if (btn.dataset.tab === 'chat') loadChatSessions();
      if (btn.dataset.tab === 'companion') loadCcSessions();
    });
  });

  // ---------- 서버 상태 ----------

  api('/api/health').then(function (h) {
    var statusEl = $('#health-status');
    if (h.claudeCli) {
      statusEl.textContent = '🟢 클로드와 연결되어 있어요';
    } else {
      statusEl.textContent = '🟠 claude 명령어를 찾지 못했어요. 설치를 확인해 주세요.';
    }
  }).catch(function () {
    $('#health-status').textContent = '🔴 서버에 연결할 수 없어요';
  });

  // ============================================================
  // 🎓 배우기
  // ============================================================

  var lessonsLoaded = false;

  function loadLessons() {
    if (lessonsLoaded) return;
    var listEl = $('#lesson-list');
    api('/api/lessons').then(function (data) {
      lessonsLoaded = true;
      listEl.innerHTML = '';
      var lessons = (data.lessons || []).slice().sort(function (a, b) { return a.order - b.order; });
      if (lessons.length === 0) {
        listEl.innerHTML = '';
        listEl.appendChild(el('div', 'empty-note',
          '아직 준비된 레슨이 없어요. 곧 채워질 예정이니 조금만 기다려 주세요. 😊'));
        return;
      }
      lessons.forEach(function (lesson) {
        var btn = el('button', 'lesson-item');
        var orderBadge = el('span', 'lesson-order', String(lesson.order));
        btn.appendChild(orderBadge);
        btn.appendChild(document.createTextNode(lesson.title));
        btn.addEventListener('click', function () {
          listEl.querySelectorAll('.lesson-item').forEach(function (b) { b.classList.remove('active'); });
          btn.classList.add('active');
          openLesson(lesson.slug);
        });
        listEl.appendChild(btn);
      });
    }).catch(function (err) {
      listEl.innerHTML = '';
      var box = el('div', 'error-box', err.message);
      listEl.appendChild(box);
    });
  }

  function openLesson(slug) {
    var contentEl = $('#lesson-content');
    contentEl.innerHTML = '';
    contentEl.appendChild(el('div', 'loading-note', '레슨을 불러오는 중이에요…'));
    api('/api/lessons/' + encodeURIComponent(slug)).then(function (data) {
      renderMarkdown(contentEl, data.markdown);
      contentEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (err) {
      contentEl.innerHTML = '';
      contentEl.appendChild(el('div', 'error-box', err.message));
    });
  }

  // ============================================================
  // 💬 채팅
  // ============================================================

  var currentChatSessionId = null;
  var chatBusy = false;

  var chatMessagesEl = $('#chat-messages');
  var chatErrorEl = $('#chat-error');
  var chatThinkingEl = $('#chat-thinking');
  var chatInputEl = $('#chat-input');
  var chatSendBtn = $('#chat-send-btn');

  function loadChatSessions() {
    var listEl = $('#chat-session-list');
    api('/api/sessions').then(function (data) {
      listEl.innerHTML = '';
      var sessions = data.sessions || [];
      if (sessions.length === 0) {
        listEl.appendChild(el('div', 'empty-note', '아직 저장된 대화가 없어요.'));
        return;
      }
      sessions.forEach(function (s) {
        var btn = el('button', 'session-item');
        if (s.id === currentChatSessionId) btn.classList.add('active');
        btn.appendChild(el('div', 'session-item-title', s.title || '(제목 없음)'));
        btn.appendChild(el('div', 'session-item-meta',
          timeAgo(s.updatedAt) + ' · 메시지 ' + s.messageCount + '개'));
        btn.addEventListener('click', function () { openChatSession(s.id); });
        listEl.appendChild(btn);
      });
    }).catch(function (err) {
      listEl.innerHTML = '';
      listEl.appendChild(el('div', 'error-box', err.message));
    });
  }

  function openChatSession(id) {
    if (chatBusy) return;
    hideError(chatErrorEl);
    chatMessagesEl.innerHTML = '';
    chatMessagesEl.appendChild(el('div', 'loading-note', '대화를 불러오는 중이에요…'));
    api('/api/sessions/' + encodeURIComponent(id)).then(function (session) {
      currentChatSessionId = session.id;
      chatMessagesEl.innerHTML = '';
      (session.messages || []).forEach(function (m) {
        appendMessage(chatMessagesEl, m.role, m.text);
      });
      scrollToBottom(chatMessagesEl);
      loadChatSessions(); // active 표시 갱신
    }).catch(function (err) {
      chatMessagesEl.innerHTML = '';
      showError(chatErrorEl, err.message);
    });
  }

  function appendMessage(containerEl, role, text) {
    var msg = el('div', 'msg ' + (role === 'user' ? 'msg-user' : 'msg-assistant'));
    if (role === 'user') {
      msg.textContent = text;
    } else {
      renderMarkdown(msg, text);
    }
    containerEl.appendChild(msg);
    return msg;
  }

  function scrollToBottom(containerEl) {
    containerEl.scrollTop = containerEl.scrollHeight;
  }

  $('#new-chat-btn').addEventListener('click', function () {
    if (chatBusy) return;
    currentChatSessionId = null;
    hideError(chatErrorEl);
    chatMessagesEl.innerHTML = '';
    chatMessagesEl.appendChild(el('div', 'empty-note',
      '새 대화예요. 아래에 첫 메시지를 적어 보세요. 😊'));
    document.querySelectorAll('#chat-session-list .session-item').forEach(function (b) {
      b.classList.remove('active');
    });
    chatInputEl.focus();
  });

  function setChatBusy(busy) {
    chatBusy = busy;
    chatSendBtn.disabled = busy;
    chatThinkingEl.classList.toggle('hidden', !busy);
  }

  function sendChat() {
    var text = chatInputEl.value.trim();
    if (!text || chatBusy) return;
    hideError(chatErrorEl);

    // 첫 메시지면 안내문 제거
    var note = chatMessagesEl.querySelector('.empty-note');
    if (note) note.remove();

    appendMessage(chatMessagesEl, 'user', text);
    scrollToBottom(chatMessagesEl);
    chatInputEl.value = '';
    setChatBusy(true);

    var body = { message: text };
    if (currentChatSessionId) body.sessionId = currentChatSessionId;

    apiPost('/api/chat', body).then(function (data) {
      currentChatSessionId = data.sessionId;
      appendMessage(chatMessagesEl, 'assistant', data.reply);
      appendCostNote(chatMessagesEl, data.costUsd);
      scrollToBottom(chatMessagesEl);
      loadChatSessions();
    }).catch(function (err) {
      showError(chatErrorEl, err.message);
    }).finally(function () {
      setChatBusy(false);
      chatInputEl.focus();
    });
  }

  $('#chat-form').addEventListener('submit', function (e) {
    e.preventDefault();
    sendChat();
  });

  chatInputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChat();
    }
  });

  // ============================================================
  // 🧭 컴패니언 — 조언 받기
  // ============================================================

  var selectedCcSession = null;

  var adviseControlsEl = $('#advise-controls');
  var adviseThinkingEl = $('#advise-thinking');
  var adviseErrorEl = $('#advise-error');
  var adviseResultEl = $('#advise-result');
  var adviseBtn = $('#advise-btn');
  var ccListLoaded = false;

  function loadCcSessions() {
    if (ccListLoaded) return;
    var listEl = $('#cc-session-list');
    api('/api/cc-sessions').then(function (data) {
      ccListLoaded = true;
      listEl.innerHTML = '';
      var sessions = data.sessions || [];
      if (sessions.length === 0) {
        listEl.appendChild(el('div', 'empty-note',
          '아직 Claude Code 작업 기록이 없어요. 터미널에서 claude를 한 번 사용해 보면 여기에 나타나요.'));
        return;
      }
      sessions.forEach(function (s) {
        var btn = el('button', 'cc-session-item');
        var projectName = humanizeProject(s.project);
        var projectEl = el('div', 'cc-session-project', '📁 ' + (projectName || '(알 수 없는 프로젝트)'));
        projectEl.title = s.project || ''; // 원본(인코딩된) 이름은 툴팁으로
        btn.appendChild(projectEl);
        btn.appendChild(el('div', 'cc-session-preview', s.preview || '(미리보기 없음)'));
        btn.appendChild(el('div', 'cc-session-time', timeAgo(s.mtime)));
        btn.addEventListener('click', function () {
          listEl.querySelectorAll('.cc-session-item').forEach(function (b) { b.classList.remove('active'); });
          btn.classList.add('active');
          selectedCcSession = s;
          $('#selected-session-label').textContent =
            '선택한 작업: ' + (projectName || '') + ' — ' + (s.preview || '').slice(0, 60);
          adviseControlsEl.classList.remove('hidden');
          adviseResultEl.classList.add('hidden');
          hideError(adviseErrorEl);
        });
        listEl.appendChild(btn);
      });
    }).catch(function (err) {
      listEl.innerHTML = '';
      listEl.appendChild(el('div', 'error-box', err.message));
    });
  }

  adviseBtn.addEventListener('click', function () {
    if (!selectedCcSession) return;
    hideError(adviseErrorEl);
    adviseResultEl.classList.add('hidden');
    adviseBtn.disabled = true;
    adviseThinkingEl.classList.remove('hidden');

    var body = { transcriptPath: selectedCcSession.path };
    var focus = $('#focus-input').value.trim();
    if (focus) body.focus = focus;

    apiPost('/api/companion/advise', body).then(function (data) {
      renderMarkdown(adviseResultEl, data.advice);
      appendCostNote(adviseResultEl, data.costUsd);
      adviseResultEl.classList.remove('hidden');
    }).catch(function (err) {
      showError(adviseErrorEl, err.message);
    }).finally(function () {
      adviseBtn.disabled = false;
      adviseThinkingEl.classList.add('hidden');
    });
  });

  // ============================================================
  // 🧭 컴패니언 — 보내기 전 다듬기
  // ============================================================

  var refineSessionId = null;
  var refineBusy = false;

  var refineMessagesEl = $('#refine-messages');
  var refineErrorEl = $('#refine-error');
  var refineThinkingEl = $('#refine-thinking');
  var refineInputEl = $('#refine-input');
  var refineSendBtn = $('#refine-send-btn');
  var refineResetBtn = $('#refine-reset-btn');

  function setRefineBusy(busy) {
    refineBusy = busy;
    refineSendBtn.disabled = busy;
    refineThinkingEl.classList.toggle('hidden', !busy);
  }

  function sendRefine() {
    var text = refineInputEl.value.trim();
    if (!text || refineBusy) return;
    hideError(refineErrorEl);

    var note = refineMessagesEl.querySelector('.empty-note');
    if (note) note.remove();

    appendMessage(refineMessagesEl, 'user', text);
    scrollToBottom(refineMessagesEl);
    refineInputEl.value = '';
    setRefineBusy(true);

    var body = { draft: text };
    if (refineSessionId) body.sessionId = refineSessionId;

    apiPost('/api/companion/refine', body).then(function (data) {
      refineSessionId = data.sessionId;
      appendMessage(refineMessagesEl, 'assistant', data.reply);
      appendCostNote(refineMessagesEl, data.costUsd);
      scrollToBottom(refineMessagesEl);
      refineSendBtn.textContent = '답장 보내기';
      refineResetBtn.classList.remove('hidden');
      refineInputEl.placeholder = '클로드의 질문에 답하거나, 더 다듬고 싶은 내용을 적어 주세요.';
    }).catch(function (err) {
      showError(refineErrorEl, err.message);
    }).finally(function () {
      setRefineBusy(false);
      refineInputEl.focus();
    });
  }

  $('#refine-form').addEventListener('submit', function (e) {
    e.preventDefault();
    sendRefine();
  });

  refineInputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendRefine();
    }
  });

  refineResetBtn.addEventListener('click', function () {
    if (refineBusy) return;
    refineSessionId = null;
    hideError(refineErrorEl);
    refineMessagesEl.innerHTML = '';
    refineMessagesEl.appendChild(el('div', 'empty-note',
      '새로 시작해요. 보내고 싶은 요청문 초안을 적어 주세요.'));
    refineSendBtn.textContent = '다듬기 시작';
    refineResetBtn.classList.add('hidden');
    refineInputEl.placeholder = '예: 우리 가게 홈페이지를 만들고 싶어요…';
    refineInputEl.focus();
  });

  // ---------- 초기 로드 ----------
  loadLessons();
})();

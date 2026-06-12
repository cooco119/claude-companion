/* 클로드 컴패니언 — 프런트 (vanilla JS, 빌드 없음) — v0.2 IA */
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

  // ---------- 탭 전환 ----------

  var currentTab = 'learn'; // 'learn' | 'news' | 'companion'

  var tabButtons = document.querySelectorAll('.tab-btn');
  tabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      tabButtons.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
      $('#view-' + btn.dataset.tab).classList.add('active');
      currentTab = btn.dataset.tab;
      hideSelectionChip();
      if (currentTab === 'learn') loadLessons();
      if (currentTab === 'companion') loadCcSessions();
      if (currentTab === 'news') {
        loadNews(false); // 탭 진입 시마다 소식 갱신 확인
        loadChannels();
      } else {
        stopNewsPolling(); // 새 소식 탭을 떠나면 폴링 중단
      }
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
  var currentLessonTitle = null; // 물어보기 컨텍스트용

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
    // 로딩 안내문/에러문이 이전 레슨 제목과 짝지어져 물어보기 컨텍스트로 새지 않도록
    // 시작 시 제목을 비우고, 성공했을 때만 다시 설정한다.
    currentLessonTitle = null;
    contentEl.innerHTML = '';
    contentEl.appendChild(el('div', 'loading-note', '레슨을 불러오는 중이에요…'));
    api('/api/lessons/' + encodeURIComponent(slug)).then(function (data) {
      currentLessonTitle = data.title || null;
      renderMarkdown(contentEl, data.markdown);
      contentEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (err) {
      contentEl.innerHTML = '';
      contentEl.appendChild(el('div', 'error-box', err.message));
    });
  }

  // ============================================================
  // 📰 새 소식 (독립 탭)
  // ============================================================

  var NEWS_POLL_INTERVAL_MS = 10 * 1000;      // 10초 간격
  var NEWS_POLL_MAX_MS = 5 * 60 * 1000;       // 최대 5분

  var newsListEl = $('#news-list');
  var newsErrorEl = $('#news-error');
  var newsRefreshingBannerEl = $('#news-refreshing-banner');
  var newsUpdatedAtEl = $('#news-updated-at');

  var newsLoading = false;
  var newsPollTimer = null;
  var newsPollDeadline = 0;
  var lastNewsItems = []; // 물어보기 컨텍스트용

  function newsTabActive() {
    var view = $('#view-news');
    return !!view && view.classList.contains('active');
  }

  function stopNewsPolling() {
    if (newsPollTimer) {
      clearTimeout(newsPollTimer);
      newsPollTimer = null;
    }
  }

  function scheduleNewsPoll() {
    stopNewsPolling();
    if (Date.now() >= newsPollDeadline) {
      // 최대 5분까지만 폴링 — 마감되면 '가져오는 중' 배너를 무한히 남겨두지 말고 종료 상태로 전환
      newsRefreshingBannerEl.classList.add('hidden');
      showError(newsErrorEl,
        '소식을 가져오는 데 시간이 걸리네요. 잠시 후 이 탭을 다시 열어 확인해 주세요.');
      return;
    }
    newsPollTimer = setTimeout(function () {
      newsPollTimer = null;
      if (newsTabActive()) loadNews(true); // 탭을 떠났으면 폴링 중단
    }, NEWS_POLL_INTERVAL_MS);
  }

  // 출처 링크는 http(s)만 허용 (그 외 스킴은 링크 미표시)
  function isSafeHttpUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
  }

  function renderNewsItems(items, refreshing, lastError) {
    newsListEl.innerHTML = '';
    if (!items || items.length === 0) {
      if (refreshing) {
        newsListEl.appendChild(el('div', 'loading-note',
          '첫 소식을 모으고 있어요. 잠시만 기다려 주세요…'));
      } else if (lastError) {
        // 실패를 '소식 없음'과 구분해서 알려준다 (대처법 포함)
        newsListEl.appendChild(el('div', 'error-box',
          '소식을 가져오는 데 실패했어요. 😢 인터넷 연결을 확인하고, 잠시 후 이 탭에 다시 들어와 주세요. 그러면 다시 시도해 볼게요.'));
      } else {
        newsListEl.appendChild(el('div', 'empty-note',
          '아직 보여드릴 소식이 없어요. 잠시 후 이 탭에 다시 들어오면 새 소식을 가져와 볼게요. 😊'));
      }
      return;
    }
    items.forEach(function (item) {
      var card = el('article', 'news-card');
      if (item.source) card.appendChild(el('div', 'news-card-source', String(item.source)));
      card.appendChild(el('h3', 'news-card-title', String(item.title || '(제목 없음)')));
      if (item.summary) card.appendChild(el('p', 'news-card-summary', String(item.summary)));
      if (item.whyGood) {
        var why = el('div', 'news-why');
        why.appendChild(el('span', 'news-why-emoji', '💡'));
        why.appendChild(el('span', 'news-why-text', String(item.whyGood)));
        card.appendChild(why);
      }
      if (isSafeHttpUrl(item.url)) {
        var link = el('a', 'news-card-link', '출처 보기 ↗');
        link.href = item.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        card.appendChild(link);
      }
      newsListEl.appendChild(card);
    });
  }

  function loadNews(isPoll) {
    if (newsLoading) return;
    newsLoading = true;
    hideError(newsErrorEl);
    api('/api/companion/news').then(function (data) {
      if (data.fetchedAt) {
        var ago = timeAgo(data.fetchedAt);
        newsUpdatedAtEl.textContent = ago ? '(' + ago + ' 업데이트)' : '';
      } else {
        newsUpdatedAtEl.textContent = '';
      }
      lastNewsItems = data.items || [];
      renderNewsItems(lastNewsItems, !!data.refreshing, data.lastError || null);
      if (data.refreshing) {
        newsRefreshingBannerEl.classList.remove('hidden');
        if (!isPoll) newsPollDeadline = Date.now() + NEWS_POLL_MAX_MS; // 새 갱신 시작 → 5분 타이머 리셋
        scheduleNewsPoll();
      } else {
        newsRefreshingBannerEl.classList.add('hidden');
        stopNewsPolling();
        // 캐시된 소식은 있는데 갱신만 실패한 경우: 목록은 유지하고 작은 경고만 보여준다
        if (data.lastError && data.items && data.items.length > 0) {
          showError(newsErrorEl,
            '새 소식 갱신에는 실패해서 이전 소식을 보여드리고 있어요. 잠시 후 이 탭에 다시 들어오면 다시 시도해 볼게요.');
        }
      }
    }).catch(function (err) {
      // 일시적 네트워크 오류로 읽고 있던 목록을 지우지 않는다 — 카드가 없을 때만 비운다
      if (!newsListEl.querySelector('.news-card')) {
        newsListEl.innerHTML = '';
      }
      showError(newsErrorEl, err.message);
      newsRefreshingBannerEl.classList.add('hidden');
      stopNewsPolling();
    }).finally(function () {
      newsLoading = false;
    });
  }

  // ---------- 새 소식: 📡 구독 채널 ----------

  var channelsListEl = $('#channels-list');
  var channelsErrorEl = $('#channels-error');
  var channelsCountEl = $('#channels-count');
  var channelsNoteEl = $('#channels-note');
  var channelUrlInput = $('#channel-url-input');
  var channelLabelInput = $('#channel-label-input');
  var channelAddBtn = $('#channel-add-btn');
  var channelsBusy = false;

  function renderChannels(channels) {
    channelsListEl.innerHTML = '';
    channelsCountEl.textContent = channels.length > 0 ? '(' + channels.length + '개)' : '';
    if (channels.length === 0) {
      channelsListEl.appendChild(el('li', 'channels-empty',
        '아직 추가한 채널이 없어요. 자주 보는 블로그 주소를 등록해 보세요.'));
      return;
    }
    channels.forEach(function (c) {
      var li = el('li', 'channel-item');
      var info = el('div', 'channel-info');
      info.appendChild(el('span', 'channel-label', String(c.label || '')));
      info.appendChild(el('span', 'channel-url', String(c.url || '')));
      li.appendChild(info);
      var delBtn = el('button', 'channel-del-btn', '삭제');
      delBtn.type = 'button';
      delBtn.addEventListener('click', function () { deleteChannel(c.id); });
      li.appendChild(delBtn);
      channelsListEl.appendChild(li);
    });
  }

  function loadChannels() {
    api('/api/news/channels').then(function (data) {
      renderChannels(data.channels || []);
    }).catch(function (err) {
      showError(channelsErrorEl, err.message);
    });
  }

  /** 채널 추가/삭제 성공 공통 처리: 목록 갱신 + 안내 + 소식 재조회(서버가 stale 처리해 둠) */
  function onChannelsChanged(channels) {
    renderChannels(channels || []);
    channelsNoteEl.classList.remove('hidden');
    loadNews(false); // 서버가 캐시를 낡은 것으로 표시했으므로 갱신 배너/폴링이 자연스럽게 시작된다
  }

  function addChannelFromInputs() {
    if (channelsBusy) return;
    var url = channelUrlInput.value.trim();
    if (url === '') {
      showError(channelsErrorEl, '구독할 채널의 주소(URL)를 먼저 붙여넣어 주세요.');
      return;
    }
    channelsBusy = true;
    channelAddBtn.disabled = true;
    hideError(channelsErrorEl);
    channelsNoteEl.classList.add('hidden');
    apiPost('/api/news/channels', { url: url, label: channelLabelInput.value.trim() })
      .then(function (data) {
        channelUrlInput.value = '';
        channelLabelInput.value = '';
        onChannelsChanged(data.channels);
      })
      .catch(function (err) { showError(channelsErrorEl, err.message); })
      .finally(function () {
        channelsBusy = false;
        channelAddBtn.disabled = false;
      });
  }

  function deleteChannel(id) {
    if (channelsBusy) return;
    channelsBusy = true;
    hideError(channelsErrorEl);
    channelsNoteEl.classList.add('hidden');
    api('/api/news/channels/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function (data) { onChannelsChanged(data.channels); })
      .catch(function (err) { showError(channelsErrorEl, err.message); })
      .finally(function () { channelsBusy = false; });
  }

  channelAddBtn.addEventListener('click', addChannelFromInputs);
  [channelUrlInput, channelLabelInput].forEach(function (input) {
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        addChannelFromInputs();
      }
    });
  });

  // ============================================================
  // 🧭 컴패니언 — (좌) 최근 작업: 조언 / 피드백 리포트
  // ============================================================

  var selectedCcSession = null;
  var workBusy = false; // 조언/피드백 중복 호출 방지

  var adviseControlsEl = $('#advise-controls');
  var adviseThinkingEl = $('#advise-thinking');
  var feedbackThinkingEl = $('#feedback-thinking');
  var adviseErrorEl = $('#advise-error');
  var adviseResultEl = $('#advise-result');
  var feedbackResultEl = $('#feedback-result');
  var adviseBtn = $('#advise-btn');
  var feedbackBtn = $('#feedback-btn');
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
          // 조언/리포트 생성 중에는 선택을 바꾸지 않는다 — 완성된 결과가
          // 새로 선택한 작업에 대한 것처럼 보이는 혼동을 막는다.
          if (workBusy) return;
          listEl.querySelectorAll('.cc-session-item').forEach(function (b) { b.classList.remove('active'); });
          btn.classList.add('active');
          selectedCcSession = s;
          $('#selected-session-label').textContent =
            '선택한 작업: ' + (projectName || '') + ' — ' + (s.preview || '').slice(0, 60);
          adviseControlsEl.classList.remove('hidden');
          adviseResultEl.classList.add('hidden');
          feedbackResultEl.classList.add('hidden');
          hideError(adviseErrorEl);
        });
        listEl.appendChild(btn);
      });
    }).catch(function (err) {
      listEl.innerHTML = '';
      listEl.appendChild(el('div', 'error-box', err.message));
    });
  }

  function setWorkBusy(busy) {
    workBusy = busy;
    adviseBtn.disabled = busy;
    feedbackBtn.disabled = busy;
  }

  adviseBtn.addEventListener('click', function () {
    if (!selectedCcSession || workBusy) return;
    hideError(adviseErrorEl);
    adviseResultEl.classList.add('hidden');
    setWorkBusy(true);
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
      setWorkBusy(false);
      adviseThinkingEl.classList.add('hidden');
    });
  });

  feedbackBtn.addEventListener('click', function () {
    if (!selectedCcSession || workBusy) return;
    hideError(adviseErrorEl);
    feedbackResultEl.classList.add('hidden');
    setWorkBusy(true);
    feedbackThinkingEl.classList.remove('hidden');

    apiPost('/api/companion/feedback', { transcriptPath: selectedCcSession.path }).then(function (data) {
      renderMarkdown(feedbackResultEl, data.report);
      appendCostNote(feedbackResultEl, data.costUsd);
      feedbackResultEl.classList.remove('hidden');
    }).catch(function (err) {
      showError(adviseErrorEl, err.message);
    }).finally(function () {
      setWorkBusy(false);
      feedbackThinkingEl.classList.add('hidden');
    });
  });

  // ============================================================
  // 🧭 컴패니언 — (우) 보내기 전 다듬기
  // ============================================================

  var refineSessionId = null;
  var refineBusy = false;
  var lastRefineDraft = null;  // 물어보기 컨텍스트용
  var lastRefineReply = null;  // 물어보기 컨텍스트용

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

  // guidance 단계 배지: mode → 라벨/색상 클래스 (모르는 mode는 배지 생략)
  var GUIDANCE_MODE_BADGES = {
    plan: { text: '🗺️ 플래닝 먼저', cls: 'badge-plan' },
    execute: { text: '⚡ 바로 실행', cls: 'badge-execute' },
    checkpoint: { text: '✋ 확인 후 진행', cls: 'badge-checkpoint' }
  };

  // refine 응답의 guidance(모델 추천 + 단계 타임라인)를 reply 아래에 렌더.
  // 모델 출력이므로 전부 textContent로만 넣는다 (innerHTML 금지).
  // isEstimate가 true면(대화 초반) '추정' 라벨을 붙이고, 새 카드가 올 때마다
  // 이전 guidance 카드는 흐리게(guidance-stale) 처리해 마지막 카드만 최신임을 보여준다.
  function renderGuidance(containerEl, guidance, isEstimate) {
    if (!guidance || typeof guidance !== 'object') return;

    // 이전 턴의 guidance 카드들은 흐리게 — 추천이 바뀌어도 서로 모순돼 보이지 않게
    containerEl.querySelectorAll('.guidance').forEach(function (old) {
      old.classList.add('guidance-stale');
    });

    var wrap = el('div', 'guidance');

    // (a) 모델 추천 카드
    if (guidance.recommendedModel) {
      var modelCard = el('div', 'guidance-model-card');
      modelCard.appendChild(el('div', 'guidance-model-label',
        isEstimate ? '🤖 지금까지 내용 기준, 추천 모델 (추정이에요)' : '🤖 이 작업에 추천하는 모델'));
      modelCard.appendChild(el('div', 'guidance-model-name', String(guidance.recommendedModel)));
      if (guidance.modelReason) {
        modelCard.appendChild(el('div', 'guidance-model-reason', String(guidance.modelReason)));
      }
      if (isEstimate) {
        modelCard.appendChild(el('div', 'guidance-estimate-note',
          '※ 대화가 진행되면 추천이 바뀔 수 있어요. 아래 대화를 이어가며 더 정확해져요.'));
      }
      modelCard.appendChild(el('div', 'guidance-model-howto',
        '이 모델로 바꾸려면: 터미널의 Claude Code에서 /model 을 입력하고 목록에서 골라 주세요.'));
      wrap.appendChild(modelCard);
    }

    // (b) 단계 타임라인
    var steps = Array.isArray(guidance.steps) ? guidance.steps : [];
    if (steps.length > 0) {
      var stepsBox = el('div', 'guidance-steps');
      stepsBox.appendChild(el('div', 'guidance-steps-title', '🪜 이런 순서로 진행해 보세요'));
      var timeline = el('ol', 'guidance-timeline');
      steps.forEach(function (step, i) {
        if (!step || typeof step !== 'object') return;
        var li = el('li', 'guidance-step');
        li.appendChild(el('span', 'guidance-step-num', String(i + 1)));
        var bodyEl = el('div', 'guidance-step-body');
        var head = el('div', 'guidance-step-head');
        head.appendChild(el('span', 'guidance-step-label', String(step.label || '')));
        var badge = GUIDANCE_MODE_BADGES[step.mode];
        if (badge) head.appendChild(el('span', 'guidance-badge ' + badge.cls, badge.text));
        bodyEl.appendChild(head);
        if (step.note) bodyEl.appendChild(el('div', 'guidance-step-note', String(step.note)));
        li.appendChild(bodyEl);
        timeline.appendChild(li);
      });
      stepsBox.appendChild(timeline);
      wrap.appendChild(stepsBox);
    }

    if (wrap.childNodes.length > 0) containerEl.appendChild(wrap);
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
    var isFirstTurn = !refineSessionId; // 첫 턴의 guidance는 '추정'으로 표시
    if (refineSessionId) body.sessionId = refineSessionId;
    if (isFirstTurn) lastRefineDraft = text;

    apiPost('/api/companion/refine', body).then(function (data) {
      refineSessionId = data.sessionId;
      lastRefineReply = data.reply || null;
      appendMessage(refineMessagesEl, 'assistant', data.reply);
      renderGuidance(refineMessagesEl, data.guidance, isFirstTurn);
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
    lastRefineDraft = null;
    lastRefineReply = null;
    hideError(refineErrorEl);
    refineMessagesEl.innerHTML = '';
    refineMessagesEl.appendChild(el('div', 'empty-note',
      '새로 시작해요. 보내고 싶은 요청문 초안을 적어 주세요.'));
    refineSendBtn.textContent = '다듬기 시작';
    refineResetBtn.classList.add('hidden');
    refineInputEl.placeholder = '예: 우리 가게 홈페이지를 만들고 싶어요…';
    refineInputEl.focus();
  });

  // ============================================================
  // ❓ 물어보기 — FAB + 슬라이드 패널 (POST /api/ask)
  // ============================================================

  var CONTEXT_MAX_CHARS = 4000; // 클라이언트에서도 4000자 절단 (서버와 동일 한도)

  var askFab = $('#ask-fab');
  var askOverlayEl = $('#ask-overlay');
  var askPanelEl = $('#ask-panel');
  var askCloseBtn = $('#ask-close-btn');
  var askNewBtn = $('#ask-new-btn');
  var askMessagesEl = $('#ask-messages');
  var askErrorEl = $('#ask-error');
  var askThinkingEl = $('#ask-thinking');
  var askInputEl = $('#ask-input');
  var askSendBtn = $('#ask-send-btn');
  var askFormEl = $('#ask-form');
  var askContextChipEl = $('#ask-context-chip');
  var askContextChipTextEl = $('#ask-context-chip-text');
  var askContextRemoveBtn = $('#ask-context-remove');
  var askQuoteBoxEl = $('#ask-quote-box');
  var askQuoteTextEl = $('#ask-quote-text');
  var askQuoteRemoveBtn = $('#ask-quote-remove');

  var askSessionId = null;
  var askBusy = false;
  var askContext = null;        // AskContext | null — 패널 열 때마다 새로 수집
  var askContextSentKey = null; // 이번 대화에서 이미 보낸 컨텍스트 (같으면 재전송하지 않음)
  var pendingQuote = null;      // 드래그 질문으로 들어온 인용 텍스트
  var askPanelOpen = false;

  // 현재 탭에서 "지금 보고 계신 것"을 AskContext로 수집한다. 볼 게 없으면 null.
  function collectAskContext() {
    var source, title, text;
    if (currentTab === 'learn') {
      source = '배우기';
      var contentEl = $('#lesson-content');
      var bodyText = contentEl ? (contentEl.textContent || '').trim() : '';
      if (!currentLessonTitle || !bodyText) return null;
      title = currentLessonTitle;
      text = bodyText;
    } else if (currentTab === 'news') {
      source = '새 소식';
      if (!lastNewsItems || lastNewsItems.length === 0) return null;
      title = '최근 소식 ' + lastNewsItems.length + '건';
      text = lastNewsItems.map(function (item) {
        var line = String(item.title || '');
        if (item.summary) line += ' — ' + String(item.summary);
        return '· ' + line;
      }).join('\n');
    } else if (currentTab === 'companion') {
      source = '컴패니언';
      var parts = [];
      if (selectedCcSession) {
        title = humanizeProject(selectedCcSession.project) || undefined;
        parts.push('선택한 Claude Code 작업: ' + (humanizeProject(selectedCcSession.project) || '') +
          ' — ' + (selectedCcSession.preview || ''));
      }
      if (lastRefineDraft) parts.push('다듬는 중인 요청문 초안: ' + lastRefineDraft);
      if (lastRefineReply) parts.push('다듬기 코치의 마지막 답변: ' + lastRefineReply);
      if (parts.length === 0) return null;
      text = parts.join('\n\n');
    } else {
      return null;
    }
    var ctx = { source: source, text: String(text).slice(0, CONTEXT_MAX_CHARS) };
    if (title) ctx.title = title;
    return ctx;
  }

  function renderContextChip() {
    if (askContext) {
      askContextChipTextEl.textContent =
        askContext.source + (askContext.title ? ' · ' + askContext.title : '');
      askContextChipEl.classList.remove('hidden');
    } else {
      askContextChipEl.classList.add('hidden');
    }
  }

  function setQuote(quoteText) {
    pendingQuote = quoteText || null;
    if (pendingQuote) {
      askQuoteTextEl.textContent = pendingQuote; // 사용자 선택 텍스트 — textContent로만
      askQuoteBoxEl.classList.remove('hidden');
    } else {
      askQuoteTextEl.textContent = '';
      askQuoteBoxEl.classList.add('hidden');
    }
  }

  // 첫 안내문을 실제 동작에 맞춘다 — 보낼 화면 내용이 없을 때는 '같이 보내드려요'라고 약속하지 않는다.
  function updateAskEmptyNote() {
    var note = askMessagesEl.querySelector('.empty-note');
    if (!note) return;
    note.textContent = askContext
      ? 'Claude Code나 이 앱에 대해 무엇이든 물어보세요. 보고 있던 화면 내용도 같이 보내드려요. 😊'
      : 'Claude Code나 이 앱에 대해 무엇이든 물어보세요. 😊';
  }

  function openAskPanel(quoteText) {
    hideSelectionChip();
    // 열 때마다 현재 화면 기준으로 컨텍스트를 새로 수집 (×로 제외했어도 다시 열면 재수집)
    askContext = collectAskContext();
    renderContextChip();
    updateAskEmptyNote();
    if (quoteText) setQuote(quoteText);
    askPanelOpen = true;
    askOverlayEl.classList.remove('hidden');
    askPanelEl.classList.add('open');
    askPanelEl.setAttribute('aria-hidden', 'false');
    askInputEl.focus();
  }

  function closeAskPanel() {
    askPanelOpen = false;
    askOverlayEl.classList.add('hidden');
    askPanelEl.classList.remove('open');
    askPanelEl.setAttribute('aria-hidden', 'true');
  }

  askFab.addEventListener('click', function () {
    if (askPanelOpen) closeAskPanel();
    else openAskPanel(null);
  });

  askCloseBtn.addEventListener('click', closeAskPanel);
  askOverlayEl.addEventListener('click', closeAskPanel); // 바깥 클릭으로 닫기

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && askPanelOpen) closeAskPanel();
  });

  askContextRemoveBtn.addEventListener('click', function () {
    askContext = null; // 이번 패널 세션에서는 컨텍스트 제외
    renderContextChip();
    updateAskEmptyNote();
  });

  askQuoteRemoveBtn.addEventListener('click', function () {
    setQuote(null);
  });

  askNewBtn.addEventListener('click', function () {
    if (askBusy) return;
    askSessionId = null;
    askContextSentKey = null; // 새 대화에서는 컨텍스트를 다시 보낼 수 있게 초기화
    setQuote(null);
    hideError(askErrorEl);
    askMessagesEl.innerHTML = '';
    askMessagesEl.appendChild(el('div', 'empty-note',
      '새 대화예요. 궁금한 점을 적어 보세요. 😊'));
    askContext = collectAskContext(); // 새 대화 시작 시 컨텍스트도 새로 수집
    renderContextChip();
    askInputEl.focus();
  });

  function setAskBusy(busy) {
    askBusy = busy;
    askSendBtn.disabled = busy;
    askThinkingEl.classList.toggle('hidden', !busy);
  }

  function sendAsk() {
    var text = askInputEl.value.trim();
    if (!text || askBusy) return;
    hideError(askErrorEl);

    var note = askMessagesEl.querySelector('.empty-note');
    if (note) note.remove();

    // 인용이 있으면 사용자 말풍선 위에 인용 블록으로 보여준다 (textContent로만)
    // 인용 상자는 전송이 '성공'한 뒤에만 비운다 — 실패하면 그대로 남아 재시도 시 다시 전송된다.
    var quoteToSend = pendingQuote;
    var quoteMsg = null;
    if (quoteToSend) {
      quoteMsg = el('blockquote', 'msg-quote', quoteToSend);
      askMessagesEl.appendChild(quoteMsg);
      askQuoteBoxEl.classList.add('hidden'); // 전송 중에는 상자를 잠시 숨긴다 (pendingQuote는 유지)
    }
    appendMessage(askMessagesEl, 'user', text);
    scrollToBottom(askMessagesEl);
    askInputEl.value = '';
    setAskBusy(true);

    var body = { question: text };
    // 같은 대화에서 이미 보낸 컨텍스트는 다시 보내지 않는다 — --resume 대화에
    // 매 턴 동일한 4KB 컨텍스트 블록이 중복 주입되는 것을 막는다.
    var contextKey = askContext ? JSON.stringify(askContext) : null;
    var contextToSend = (askContext && contextKey !== askContextSentKey) ? askContext : null;
    if (contextToSend) body.context = contextToSend;
    if (quoteToSend) body.quote = quoteToSend;
    if (askSessionId) body.sessionId = askSessionId;

    apiPost('/api/ask', body).then(function (data) {
      askSessionId = data.sessionId;
      if (contextToSend) askContextSentKey = contextKey; // 전송 성공 — 같은 내용은 재전송하지 않음
      if (quoteToSend) setQuote(null); // 한 번 '성공적으로' 보내면 인용은 비운다
      appendMessage(askMessagesEl, 'assistant', data.reply); // marked+DOMPurify 경유
      appendCostNote(askMessagesEl, data.costUsd);
      scrollToBottom(askMessagesEl);
    }).catch(function (err) {
      // 전송 실패 — 인용 말풍선을 제거해 '보낸 것처럼' 보이지 않게 하고,
      // 인용 상자(pendingQuote)는 복원해 재시도 시 함께 전송되게 한다.
      if (quoteMsg) {
        quoteMsg.remove();
        askQuoteBoxEl.classList.remove('hidden');
      }
      showError(askErrorEl, err.message);
    }).finally(function () {
      setAskBusy(false);
      askInputEl.focus();
    });
  }

  askFormEl.addEventListener('submit', function (e) {
    e.preventDefault();
    sendAsk();
  });

  askInputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendAsk();
    }
  });

  // ============================================================
  // ❓ 드래그 질문 — 텍스트 선택 시 "이 부분 물어보기" 칩
  // ============================================================

  var selectionChipEl = $('#selection-chip');
  var selectionChipText = null;       // 칩을 띄울 때의 선택 텍스트
  var selectionDebounceTimer = null;
  var SELECTION_DEBOUNCE_MS = 200;
  // 한국어에는 '파일', '폴더', '백업' 같은 2글자 단어가 흔하므로 2글자부터 칩을 띄운다
  // (레슨 2의 '모르는 단어 하나를 드래그' 실습과 일치).
  var SELECTION_MIN_CHARS = 2;

  function hideSelectionChip() {
    // 대기 중인 디바운스 타이머도 함께 취소 — 칩을 누른 직후 타이머가 발화해
    // 열린 패널 위로 칩이 다시 떠오르는 것을 막는다.
    if (selectionDebounceTimer) {
      clearTimeout(selectionDebounceTimer);
      selectionDebounceTimer = null;
    }
    selectionChipEl.classList.add('hidden');
    selectionChipText = null;
  }

  // 선택 영역이 칩을 띄우면 안 되는 곳(입력창/버튼/물어보기 패널 등)에 있는지 검사
  function selectionInExcludedArea(node) {
    var elNode = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!elNode || !elNode.closest) return true;
    if (elNode.closest('textarea, input, button, .ask-panel, .ask-fab, .selection-chip, .sidebar')) {
      return true;
    }
    // 앱 콘텐츠 영역(.main) 안에서만 칩을 띄운다
    return !elNode.closest('.main');
  }

  function showSelectionChipAt(rect, text) {
    selectionChipText = text;
    selectionChipEl.classList.remove('hidden');
    // 선택 끝 좌표 근처에 표시 (position: fixed — 화면 밖으로 나가지 않게 보정)
    var chipW = selectionChipEl.offsetWidth || 170;
    var chipH = selectionChipEl.offsetHeight || 40;
    var left = Math.min(rect.right + 6, window.innerWidth - chipW - 12);
    var top = rect.bottom + 8;
    if (top + chipH > window.innerHeight - 12) top = Math.max(12, rect.top - chipH - 8);
    selectionChipEl.style.left = Math.max(12, left) + 'px';
    selectionChipEl.style.top = top + 'px';
  }

  function handleSelectionChange() {
    if (askPanelOpen) return; // 물어보기 패널이 열려 있는 동안에는 칩을 띄우지 않는다
    var sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      hideSelectionChip();
      return;
    }
    var text = sel.toString().trim();
    if (text.length < SELECTION_MIN_CHARS) {
      hideSelectionChip();
      return;
    }
    var range = sel.getRangeAt(0);
    if (selectionInExcludedArea(range.commonAncestorContainer)) {
      hideSelectionChip();
      return;
    }
    var rects = range.getClientRects();
    var rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      hideSelectionChip();
      return;
    }
    showSelectionChipAt(rect, text);
  }

  document.addEventListener('selectionchange', function () {
    if (selectionDebounceTimer) clearTimeout(selectionDebounceTimer);
    selectionDebounceTimer = setTimeout(function () {
      selectionDebounceTimer = null;
      handleSelectionChange();
    }, SELECTION_DEBOUNCE_MS);
  });

  function activateSelectionChip() {
    var quote = selectionChipText;
    hideSelectionChip();
    if (quote) openAskPanel(quote.slice(0, CONTEXT_MAX_CHARS));
  }

  // 칩 클릭: mousedown에서 preventDefault — 클릭으로 선택이 풀리기 전에 처리한다
  selectionChipEl.addEventListener('mousedown', function (e) {
    e.preventDefault();
    e.stopPropagation();
    activateSelectionChip();
  });

  // 키보드 사용자: 칩은 button이므로 Enter/Space로도 동작해야 한다
  selectionChipEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activateSelectionChip();
    }
  });

  // 스크롤하거나 다른 곳을 클릭하면 칩을 숨긴다 (capture: .main 내부 스크롤도 포착)
  window.addEventListener('scroll', hideSelectionChip, true);
  document.addEventListener('mousedown', function (e) {
    if (!selectionChipEl.classList.contains('hidden') &&
        !selectionChipEl.contains(e.target)) {
      hideSelectionChip();
    }
  });

  // ---------- 초기 로드 ----------
  loadLessons();
})();

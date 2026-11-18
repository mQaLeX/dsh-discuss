const STYLE = `
[hidden] { display: none !important; }
:root {
  color-scheme: light dark;
  --bg: #fafaf8;
  --panel: #ffffff;
  --panel-2: #f4f4f1;
  --border: #e6e5df;
  --text: #1d1e21;
  --muted: #71737a;
  --accent: #2f6f5e;
  --accent-weak: #e3f0ec;
  --bubble: #f0f0ec;
  --bubble-comment: #edf4f1;
  --danger: #b42318;
  --danger-weak: #fdecea;
  --shadow: 0 1px 2px rgba(20, 22, 24, .05);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141518;
    --panel: #1b1c20;
    --panel-2: #222329;
    --border: #2c2e34;
    --text: #e8e9ec;
    --muted: #9a9ca4;
    --accent: #7ec4ae;
    --accent-weak: #223832;
    --bubble: #26282e;
    --bubble-comment: #232d2a;
    --danger: #ff9d93;
    --danger-weak: #3b2320;
    --shadow: none;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
button { font: inherit; }
.app {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  height: 100vh;
  height: 100dvh;
}
.sidebar {
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--panel);
  border-right: 1px solid var(--border);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 18px 14px;
}
.brand-mark {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: #fff;
  font-weight: 700;
  font-size: 16px;
}
.brand strong { display: block; font-size: 15px; letter-spacing: .01em; }
.brand small {
  display: block;
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: .09em;
}
.sidebar-label {
  padding: 8px 20px 6px;
  color: var(--muted);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .09em;
}
.topic-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.topic {
  appearance: none;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.topic:hover { background: var(--panel-2); }
.topic.active { background: var(--accent-weak); }
.topic-top { display: flex; align-items: center; gap: 8px; }
.topic-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 13px;
}
.topic-count {
  flex: none;
  min-width: 22px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--bg);
  color: var(--muted);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}
.topic.active .topic-count { background: var(--panel-2); color: var(--accent); }
.topic-sub {
  display: block;
  margin-top: 2px;
  color: var(--muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.chat {
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}
.chat-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 24px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.chat-title { min-width: 0; }
.chat-title h1 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-title p {
  margin: 3px 0 0;
  color: var(--muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip {
  flex: none;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--accent-weak);
  color: var(--accent);
  font-size: 12px;
  font-weight: 650;
}
.error {
  margin: 12px 24px 0;
  padding: 9px 12px;
  border-radius: 8px;
  background: var(--danger-weak);
  color: var(--danger);
  font-size: 13px;
}
.history-note {
  margin: 12px 24px 0;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  font-size: 12px;
}
.messages {
  --pad-x: 24px;
  flex: 1;
  overflow-y: auto;
  padding: 18px var(--pad-x) 28px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
}
.empty {
  margin: auto;
  padding: 24px;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}
.empty.small { margin: 8px; padding: 12px; text-align: left; }
.day {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 0 18px;
  color: var(--muted);
  font-size: 10px;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: .07em;
}
.day::before, .day::after { content: ""; flex: 1; height: 1px; background: var(--border); }
.message {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 10px;
  width: 100%;
  margin-top: 4px;
  position: relative;
}
.message.group-start { margin-top: 18px; }
.message > * { position: relative; z-index: 1; }
.message::before {
  content: "";
  position: absolute;
  inset: -6px calc(-1 * var(--pad-x));
  border-radius: 12px;
  background: transparent;
  pointer-events: none;
  z-index: 0;
}
.message.flash::before { animation: row-flash 1.2s ease; }
@keyframes row-flash {
  0% { background-color: transparent; }
  18% { background-color: var(--accent-weak); }
  72% { background-color: var(--accent-weak); }
  100% { background-color: transparent; }
}
.avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .02em;
}
.message:not(.group-start) .avatar { visibility: hidden; }
.message-body { min-width: 0; }
.message-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  margin: 1px 0 4px 2px;
}
.author { font-weight: 650; font-size: 13px; }
.time { color: var(--muted); font-size: 11px; }
.kind, .mention {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 650;
}
.kind { background: var(--bubble); color: var(--muted); text-transform: uppercase; letter-spacing: .03em; }
.mention { background: var(--accent-weak); color: var(--accent); }
.bubble {
  width: fit-content;
  max-width: 100%;
  padding: 9px 13px;
  border-radius: 4px 13px 13px 13px;
  background: var(--bubble);
  box-shadow: var(--shadow);
}
.bubble.comment { background: var(--bubble-comment); }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.reply {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0 0 7px;
  padding: 5px 8px;
  border-left: 3px solid var(--accent);
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--muted);
  font-size: 12px;
}
.reply.clickable { cursor: pointer; }
.reply.clickable:hover { background: var(--panel); }
.reply-arrow { flex: none; color: var(--accent); }
.reply-author { flex: none; color: var(--text); font-weight: 600; }
.reply-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 7px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--muted);
  font-size: 12px;
}
.file-mark {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--accent-weak);
  color: var(--accent);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: .04em;
}
.chat-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 24px;
  border-top: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  font-size: 11px;
}
@media (max-width: 760px) {
  .app { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .sidebar { max-height: 38vh; border-right: 0; border-bottom: 1px solid var(--border); }
  .brand { padding: 12px 16px 8px; }
  .sidebar-label { display: none; }
  .topic-list {
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 0 12px 10px;
  }
  .topic { width: auto; flex: none; max-width: 220px; }
  .topic-sub { display: none; }
  .chat-header { padding: 12px 16px; }
  .messages { --pad-x: 16px; padding: 14px var(--pad-x) 20px; }
  .error, .history-note { margin: 10px 16px 0; }
  .chat-footer { padding: 8px 16px; }
}
`

const SCRIPT = `
(function () {
  'use strict';

  var PALETTE = ['#c26a3d', '#4f7cc7', '#3f8f6b', '#9a5bb5', '#b85450', '#3b8fa3', '#7a6bd1', '#a0782f'];

  var nodes = {
    topicList: document.getElementById('topic-list'),
    topicName: document.getElementById('topic-name'),
    topicMeta: document.getElementById('topic-meta'),
    messageCount: document.getElementById('message-count'),
    messages: document.getElementById('messages'),
    error: document.getElementById('error'),
    history: document.getElementById('history-note'),
    status: document.getElementById('status')
  };

  var state = { topicId: null, request: 0 };
  var flashTimers = new WeakMap();
  var scrollToken = 0;

  function node(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function colorFor(name) {
    var value = String(name || '');
    var hash = 0;
    for (var index = 0; index < value.length; index += 1) {
      hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
    }
    return PALETTE[hash % PALETTE.length];
  }

  function initials(name) {
    var parts = String(name || '?').split('-');
    var first = parts[0] && parts[0][0] ? parts[0][0] : '?';
    var second = parts[1] && parts[1][0] ? parts[1][0] : '';
    return (first + second).toUpperCase();
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
  }

  function formatTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function sameDay(left, right) {
    var a = new Date(left);
    var b = new Date(right);
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }

  function dayLabel(ms) {
    var now = Date.now();
    if (sameDay(ms, now)) return 'Today';
    if (sameDay(ms, now - 86400000)) return 'Yesterday';
    return new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function shorten(text, limit) {
    var value = String(text || '');
    return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
  }

  function setStatus(text) {
    nodes.status.textContent = text;
  }

  function topicButton(topic) {
    var button = node('button', 'topic');
    button.type = 'button';
    button.title = topic.name;
    if (topic.id === state.topicId) {
      button.classList.add('active');
      button.setAttribute('aria-current', 'true');
    }
    var top = node('span', 'topic-top');
    top.append(node('span', 'topic-name', topic.name));
    top.append(node('span', 'topic-count', topic.messages));
    var sub = node('span', 'topic-sub');
    sub.append(node('span', 'mono', topic.id));
    sub.append(node('span', '', ' · ' + topic.subscribers + ' subscriber' + (topic.subscribers === 1 ? '' : 's')));
    button.append(top, sub);
    button.addEventListener('click', function () { selectTopic(topic.id); });
    return button;
  }

  function renderTopics(data) {
    nodes.topicList.replaceChildren();
    if (data.topics.length === 0) {
      nodes.topicList.append(node('div', 'empty small', 'No topics yet. Create one with the admin preset.'));
      return;
    }
    for (var index = 0; index < data.topics.length; index += 1) {
      nodes.topicList.append(topicButton(data.topics[index]));
    }
  }

  function replyNode(message, byId) {
    if (message.parent === null || message.parent === undefined) return null;
    var parent = byId[message.parent];
    var reply = node('div', 'reply');
    reply.append(node('span', 'reply-arrow', '↳'));
    if (parent === undefined) {
      reply.append(node('span', 'reply-text', 'message #' + message.parent + ' (older)'));
      return reply;
    }
    reply.classList.add('clickable');
    reply.append(node('span', 'reply-author', '@' + parent.user));
    reply.append(node('span', 'reply-text', shorten(parent.text, 90)));
    reply.addEventListener('click', function () { scrollToMessage(parent.id); });
    return reply;
  }

  function messageNode(message, previous, byId) {
    var grouped = previous !== null
      && previous.user === message.user
      && sameDay(previous.createdAt, message.createdAt)
      && (message.createdAt - previous.createdAt) < 300000;
    var row = node('div', grouped ? 'message' : 'message group-start');
    row.id = 'message-' + message.id;

    var avatar = node('div', 'avatar');
    if (!grouped) {
      avatar.style.background = colorFor(message.user);
      avatar.textContent = initials(message.user);
    }
    var body = node('div', 'message-body');
    if (!grouped) {
      var head = node('div', 'message-head');
      head.append(node('span', 'author', message.user));
      head.append(node('span', 'time', formatTime(message.createdAt)));
      if (message.kind === 'comment') head.append(node('span', 'kind', 'reply'));
      if (message.at) head.append(node('span', 'mention', '@' + message.at));
      body.append(head);
    }
    var bubble = node('div', message.kind === 'comment' ? 'bubble comment' : 'bubble');
    var reply = replyNode(message, byId);
    if (reply !== null) bubble.append(reply);
    if (message.text) bubble.append(node('div', 'text', message.text));
    if (message.fileSize !== null && message.fileSize !== undefined) {
      var file = node('div', 'file');
      file.append(node('span', 'file-mark', 'FILE'));
      file.append(node('span', '', formatSize(message.fileSize)));
      bubble.append(file);
    }
    body.append(bubble);
    row.append(avatar, body);
    return row;
  }

  function dayNode(ms) {
    var day = node('div', 'day');
    day.append(node('span', '', dayLabel(ms)));
    return day;
  }

  function renderMessages(data) {
    nodes.messages.replaceChildren();
    var messages = data.messages;
    if (messages.length === 0) {
      nodes.messages.append(node('div', 'empty', 'No messages in this topic yet.'));
      return;
    }
    var byId = Object.create(null);
    for (var index = 0; index < messages.length; index += 1) byId[messages[index].id] = messages[index];
    var previous = null;
    for (var index = 0; index < messages.length; index += 1) {
      var message = messages[index];
      if (previous === null || !sameDay(previous.createdAt, message.createdAt)) {
        nodes.messages.append(dayNode(message.createdAt));
      }
      nodes.messages.append(messageNode(message, previous, byId));
      previous = message;
    }
  }

  function flashMessage(target) {
    var previous = flashTimers.get(target);
    if (previous !== undefined) window.clearTimeout(previous);
    target.classList.remove('flash');
    // Restart the animation when the same message is clicked again.
    void target.offsetWidth;
    target.classList.add('flash');
    var timer = window.setTimeout(function () {
      target.classList.remove('flash');
      flashTimers.delete(target);
    }, 1300);
    flashTimers.set(target, timer);
  }

  function animateScroll(container, to, duration, done) {
    var from = container.scrollTop;
    var distance = to - from;
    if (Math.abs(distance) < 2) {
      container.scrollTop = to;
      done();
      return;
    }
    var started = null;
    function step(now) {
      if (started === null) started = now;
      var progress = Math.min(1, (now - started) / duration);
      var eased = 1 - Math.pow(1 - progress, 3);
      container.scrollTop = from + distance * eased;
      if (progress < 1) window.requestAnimationFrame(step);
      else done();
    }
    window.requestAnimationFrame(step);
  }

  function scrollToMessage(id) {
    var target = document.getElementById('message-' + id);
    if (target === null) return;
    var container = nodes.messages;
    var targetRect = target.getBoundingClientRect();
    var containerRect = container.getBoundingClientRect();
    var top = container.scrollTop
      + (targetRect.top - containerRect.top)
      - (container.clientHeight - targetRect.height) / 2;
    var max = Math.max(0, container.scrollHeight - container.clientHeight);
    var desired = Math.max(0, Math.min(top, max));
    var token = ++scrollToken;
    var reduced = window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      container.scrollTop = desired;
      flashMessage(target);
      return;
    }
    animateScroll(container, desired, 320, function () {
      if (token === scrollToken) flashMessage(target);
    });
  }

  function scrollToBottom() {
    nodes.messages.scrollTop = nodes.messages.scrollHeight;
  }

  function render(data) {
    state.topicId = data.selected === null ? null : data.selected.id;
    renderTopics(data);
    if (data.selected === null) {
      nodes.topicName.textContent = 'No topics yet';
      nodes.topicMeta.textContent = 'Create a topic with the admin preset to start a conversation.';
      nodes.messageCount.textContent = '0';
      nodes.history.hidden = true;
    } else {
      nodes.topicName.textContent = data.selected.name;
      nodes.topicMeta.textContent = data.selected.id
        + ' · ' + data.selected.subscribers
        + ' subscriber' + (data.selected.subscribers === 1 ? '' : 's');
      nodes.messageCount.textContent = String(data.selected.messages);
      if (data.truncated) {
        nodes.history.textContent = 'Showing the latest '
          + data.messages.length + ' of ' + data.selected.messages + ' messages.';
        nodes.history.hidden = false;
      } else {
        nodes.history.hidden = true;
      }
    }
    renderMessages(data);
  }

  async function load(topicId, initial) {
    var request = ++state.request;
    var url = '/dashboard/api';
    if (topicId) url += '?topic=' + encodeURIComponent(topicId);
    try {
      var response = await fetch(url, { cache: 'no-store' });
      if (response.status === 404 && topicId) {
        state.topicId = null;
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', window.location.pathname);
        }
        response = await fetch('/dashboard/api', { cache: 'no-store' });
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var data = await response.json();
      if (request !== state.request) return;
      var stick = initial === true
        || (nodes.messages.scrollHeight - nodes.messages.scrollTop - nodes.messages.clientHeight < 120);
      render(data);
      if (stick) requestAnimationFrame(scrollToBottom);
      nodes.error.hidden = true;
      setStatus('read-only · updated '
        + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    } catch (error) {
      if (request !== state.request) return;
      nodes.error.hidden = false;
      nodes.error.textContent = 'Cannot reach the board; retrying automatically.';
      setStatus('offline');
    }
  }

  function selectTopic(id) {
    if (state.topicId === id) return;
    state.topicId = id;
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', '?topic=' + encodeURIComponent(id));
    }
    nodes.messages.replaceChildren(node('div', 'empty', 'Loading…'));
    load(id, true);
  }

  var initialTopic = null;
  if (window.URLSearchParams) initialTopic = new URLSearchParams(window.location.search).get('topic');
  load(initialTopic, true);
  window.setInterval(function () { load(state.topicId, false); }, 5000);
})();
`

/** Render the read-only chat dashboard shell; data arrives from `/dashboard/api`. */
export function renderDashboard() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>dsh-discuss</title>
<style>${STYLE}</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-mark">#</div>
      <div>
        <strong>dsh-discuss</strong>
        <small>Read-only board</small>
      </div>
    </div>
    <div class="sidebar-label">Topics</div>
    <nav id="topic-list" class="topic-list" aria-label="Topics"></nav>
  </aside>
  <main class="chat">
    <header class="chat-header">
      <div class="chat-title">
        <h1 id="topic-name">Loading…</h1>
        <p id="topic-meta">Connecting to the board…</p>
      </div>
      <span id="message-count" class="chip" title="messages in this topic">–</span>
    </header>
    <div id="error" class="error" hidden></div>
    <div id="history-note" class="history-note" hidden></div>
    <div id="messages" class="messages" aria-live="polite"></div>
    <footer class="chat-footer">
      <span id="status">read-only</span>
      <span>refreshes every 5s</span>
    </footer>
  </main>
</div>
<script>${SCRIPT}</script>
</body>
</html>`
}

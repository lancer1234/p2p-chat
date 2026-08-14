from pathlib import Path

index = Path('index.html')
s = index.read_text()

css_anchor = "        #reader { width: 100%; max-width: 320px; margin: 20px auto; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; display: none; }"
css_insert = """        .conversation-section { margin: 18px 0 14px; text-align: left; }
        .conversation-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; padding: 0 2px; }
        .conversation-title { font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; color: var(--text-muted); text-transform: uppercase; }
        #chat-count { font-family: monospace; font-size: 0.7rem; color: var(--text-muted); }
        #chat-list { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: #0D0D10; }
        .chat-empty { padding: 24px 14px; text-align: center; color: var(--text-muted); font-size: 0.78rem; line-height: 1.55; }
        .chat-row { display: flex; align-items: center; min-height: 66px; border-bottom: 1px solid var(--border); background: transparent; }
        .chat-row:last-child { border-bottom: none; }
        .chat-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 11px; padding: 11px 10px 11px 12px; border: 0; border-radius: 0; background: transparent; text-align: left; }
        .chat-open:active { background: var(--panel); }
        .chat-avatar { width: 34px; height: 34px; flex: 0 0 34px; border: 1px solid #2D2D32; border-radius: 50%; display: grid; place-items: center; color: var(--accent); font-family: monospace; font-size: 0.72rem; background: var(--panel); }
        .chat-main { min-width: 0; flex: 1; }
        .chat-topline { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
        .chat-name { color: var(--text); font-size: 0.9rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .chat-time { flex: 0 0 auto; color: var(--text-muted); font-size: 0.66rem; font-family: monospace; }
        .chat-preview { margin-top: 4px; color: var(--text-muted); font-size: 0.76rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .chat-delete { width: auto; flex: 0 0 auto; border: 0; border-left: 1px solid var(--border); border-radius: 0; background: transparent; color: #3F3F46; padding: 22px 12px; font-size: 0.9rem; }
        .chat-delete:hover { color: var(--danger); }
        #btn-new-chat { margin-top: 10px; border-color: rgba(0,255,204,0.35); color: var(--accent); }
        #pair-actions { display: none; margin-top: 10px; gap: 8px; }
        #pair-actions button { padding: 12px; font-size: 0.82rem; }
        #chat-peer-name { font-size: 0.72rem; color: var(--text); font-weight: 600; max-width: 250px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

""" + css_anchor
if css_anchor not in s:
    raise SystemExit('index css anchor missing')
s = s.replace(css_anchor, css_insert, 1)

old_buttons = """        <div class=\"btn-group\">\n            <button id=\"btn-resume\">恢復上一次的加密對話</button>\n            <button id=\"btn-create\">1. 產生邀請 QR Code</button>\n            <button id=\"btn-scan\">2. 掃描對方 QR Code</button>\n        </div>"""
new_buttons = """        <div class=\"conversation-section\">\n            <div class=\"conversation-heading\">\n                <span class=\"conversation-title\">對話</span>\n                <span id=\"chat-count\">0</span>\n            </div>\n            <div id=\"chat-list\"></div>\n            <button id=\"btn-new-chat\">＋ 新增對話</button>\n            <div id=\"pair-actions\" class=\"btn-group\">\n                <button id=\"btn-create\">產生邀請 QR Code</button>\n                <button id=\"btn-scan\">掃描對方 QR Code</button>\n            </div>\n        </div>"""
if old_buttons not in s:
    raise SystemExit('index buttons anchor missing')
s = s.replace(old_buttons, new_buttons, 1)

old_stack = """                <div class=\"status-stack\">\n                    <span id=\"status-text\" class=\"status-text\">IDLE</span>\n                    <span id=\"network-detail\">ICE: INITIALIZING</span>\n                </div>"""
new_stack = """                <div class=\"status-stack\">\n                    <span id=\"chat-peer-name\">對話</span>\n                    <span id=\"status-text\" class=\"status-text\">IDLE</span>\n                    <span id=\"network-detail\">ICE: INITIALIZING</span>\n                </div>"""
if old_stack not in s:
    raise SystemExit('index status anchor missing')
s = s.replace(old_stack, new_stack, 1)
s = s.replace('<button id="btn-leave">[ 離開對話 ]</button>', '<button id="btn-leave">[ 返回 ]</button>', 1)
s = s.replace('20260814-GitHubPages-Worker-v17-direct-first', '20260814-v18-multi-chat', 1)
index.write_text(s)

app = Path('js/app.js')
s = app.read_text()

old_ready = """    } else if (nextState === STATE_READY) {\n        document.getElementById('setup-container').style.display = 'block';\n        const savedLastPk = Storage.getLastChatPk();\n        document.getElementById('btn-resume').style.display = savedLastPk ? 'block' : 'none';"""
new_ready = """    } else if (nextState === STATE_READY) {\n        document.getElementById('setup-container').style.display = 'block';\n        renderChatList();\n        const pairActions = document.getElementById('pair-actions');\n        if (pairActions) pairActions.style.display = 'none';"""
if old_ready not in s:
    raise SystemExit('app ready anchor missing')
s = s.replace(old_ready, new_ready, 1)

start = "document.getElementById('btn-resume').addEventListener('click', function() {"
end = "    beginReconnectIfLeader('resume');\n});"
a = s.find(start)
if a < 0:
    raise SystemExit('resume start missing')
b = s.find(end, a)
if b < 0:
    raise SystemExit('resume end missing')
b += len(end)

replacement = r'''function formatChatTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    if (sameDay) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const diff = now.getTime() - date.getTime();
    if (diff < 7 * 24 * 60 * 60 * 1000) return date.toLocaleDateString([], { weekday: 'short' });
    return date.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
}

function getFriendDisplayName(friendPk) {
    const friend = Storage.getFriends()[friendPk];
    return friend?.name || `聯絡人 ${String(friendPk || '').slice(0, 8)}`;
}

function updateCurrentPeerLabel() {
    const el = document.getElementById('chat-peer-name');
    if (!el) return;
    el.innerText = currentFriendPk ? getFriendDisplayName(currentFriendPk) : '對話';
}

function renderChatList() {
    const list = document.getElementById('chat-list');
    const count = document.getElementById('chat-count');
    if (!list) return;
    const chats = Storage.getChatList();
    if (count) count.innerText = String(chats.length);
    list.innerHTML = '';

    if (chats.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'chat-empty';
        empty.innerText = '目前沒有對話\n按「＋ 新增對話」開始配對';
        list.appendChild(empty);
        return;
    }

    chats.forEach(chat => {
        const row = document.createElement('div');
        row.className = 'chat-row';
        const open = document.createElement('button');
        open.className = 'chat-open';
        open.dataset.pk = chat.pk;
        const avatar = document.createElement('div');
        avatar.className = 'chat-avatar';
        avatar.innerText = chat.pk.slice(0, 2).toUpperCase();
        const main = document.createElement('div');
        main.className = 'chat-main';
        const top = document.createElement('div');
        top.className = 'chat-topline';
        const name = document.createElement('span');
        name.className = 'chat-name';
        name.innerText = chat.name;
        const time = document.createElement('span');
        time.className = 'chat-time';
        time.innerText = formatChatTime(chat.updatedAt);
        top.append(name, time);
        const preview = document.createElement('div');
        preview.className = 'chat-preview';
        preview.innerText = chat.lastMessage || '尚無訊息';
        main.append(top, preview);
        open.append(avatar, main);
        const del = document.createElement('button');
        del.className = 'chat-delete';
        del.dataset.deletePk = chat.pk;
        del.setAttribute('aria-label', '刪除對話');
        del.innerText = '×';
        row.append(open, del);
        list.appendChild(row);
    });
}

function openConversation(friendPk) {
    if (!isValidPubkey(friendPk)) return;
    if (!isNostrReady) {
        alert('矩陣仍在同步中，請稍候。');
        return;
    }
    clearSessionState();
    currentFriendPk = friendPk;
    currentNegotiationId = null;
    reconnectAttempt = 0;
    Storage.touchFriend(friendPk);
    resetRelayModeForDirectAttempt('open-conversation', !relayCredentialsStillValid());
    updateCurrentPeerLabel();
    transitionToState(STATE_CONNECTING);
    restoreChatLogs();
    listenForMessages(currentFriendPk);
    beginReconnectIfLeader('chat-list-open');
}

async function returnToChatList() {
    const leavingPk = currentFriendPk;
    if (leavingPk && isNostrReady) {
        try {
            const encrypted = await encodeSignaling(leavingPk, { type: 'leave', negotiationId: currentNegotiationId });
            await nostr.sendEvent(myKeyPair.sk, leavingPk, encrypted);
        } catch (error) {
            logger.error('leave signaling 發送失敗', error);
        }
    }
    clearSessionState();
    currentFriendPk = null;
    updateCurrentPeerLabel();
    transitionToState(STATE_READY);
}

function deleteConversation(friendPk) {
    if (!isValidPubkey(friendPk)) return;
    const name = getFriendDisplayName(friendPk);
    if (!confirm(`刪除「${name}」？\n\n本機聊天紀錄也會一起刪除。`)) return;
    Storage.clearSession(friendPk);
    renderChatList();
}

document.getElementById('chat-list').addEventListener('click', function(event) {
    const deleteButton = event.target.closest('[data-delete-pk]');
    if (deleteButton) {
        event.stopPropagation();
        deleteConversation(deleteButton.dataset.deletePk);
        return;
    }
    const openButton = event.target.closest('[data-pk]');
    if (openButton) openConversation(openButton.dataset.pk);
});

document.getElementById('btn-new-chat').addEventListener('click', function() {
    const actions = document.getElementById('pair-actions');
    if (!actions) return;
    actions.style.display = actions.style.display === 'flex' ? 'none' : 'flex';
});'''
s = s[:a] + replacement + s[b:]

s = s.replace("document.getElementById('btn-leave').addEventListener('click', leaveChat);", "document.getElementById('btn-leave').addEventListener('click', returnToChatList);", 1)
s = s.replace("appendMessage('對方已離開對話。', 'system');", "appendMessage('對方目前未開啟此對話。', 'system');", 1)

old_leave = """async function leaveChat() {\n    if (!confirm('確定要終止並離開對話？這將會徹底抹除本地的所有對話紀錄。')) return;\n\n    if (currentFriendPk && isNostrReady) {\n        try {\n            const encrypted = await encodeSignaling(currentFriendPk, {\n                type: 'leave',\n                negotiationId: currentNegotiationId\n            });\n            await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encrypted);\n        } catch (error) {\n            logger.error('leave signaling 發送失敗', error);\n        }\n    }\n\n    if (currentFriendPk) Storage.clearSession(currentFriendPk);\n    clearSessionState();\n    currentFriendPk = null;\n    transitionToState(STATE_READY);\n}\n\n"""
if old_leave not in s:
    raise SystemExit('old leave function missing')
s = s.replace(old_leave, '', 1)

chat_transition = """    } else if (nextState === STATE_CONNECTING || nextState === STATE_CONNECTED) {\n        document.getElementById('chat-interface').style.display = 'flex';\n        updateOnlineStatus(nextState === STATE_CONNECTED);"""
chat_transition_new = """    } else if (nextState === STATE_CONNECTING || nextState === STATE_CONNECTED) {\n        document.getElementById('chat-interface').style.display = 'flex';\n        updateCurrentPeerLabel();\n        updateOnlineStatus(nextState === STATE_CONNECTED);"""
if chat_transition not in s:
    raise SystemExit('chat transition anchor missing')
s = s.replace(chat_transition, chat_transition_new, 1)

app.write_text(s)

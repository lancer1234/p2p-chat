from pathlib import Path

# ---- index.html ----
p = Path('index.html')
s = p.read_text()

# Clean viewport CSS from previous experiments.
s = s.replace('            --app-height: 100dvh;\n', '', 1)
s = s.replace('            height: var(--vv-height, 100dvh);\n            min-height: 0;', '            height: var(--vv-height, 100dvh);\n            min-height: 0;', 1)
s = s.replace('            position: absolute;\n            top: 0;\n            left: 0;\n            right: 0;\n            transform: translate3d(0, var(--vv-top, 0px), 0);\n            will-change: transform, height;', '            position: fixed;\n            top: 0;\n            left: 0;\n            right: 0;\n            transform: none;\n            will-change: height;', 1)
s = s.replace('            padding-bottom: calc(24px + var(--keyboard-height));\n', '', 1)

# Replace visible real input with proxy + display shell.
old_input = '''        <div id="chat-input-area">\n            <input type="text" id="input-msg" placeholder="輸入訊息..." autocomplete="off">\n            <button id="btn-send">發送</button>\n        </div>'''
new_input = '''        <div id="chat-input-area">\n            <input type="text" id="input-msg" class="ios-keyboard-proxy" autocomplete="off" autocapitalize="sentences" enterkeyhint="send" aria-label="輸入訊息">\n            <div id="input-msg-display" class="input-msg-display" role="textbox" aria-label="輸入訊息" data-placeholder="輸入訊息..."></div>\n            <button id="btn-send">發送</button>\n        </div>'''
if old_input not in s:
    raise SystemExit('chat input block not found')
s = s.replace(old_input, new_input, 1)

# Replace old input CSS rule with proxy + visible display styles.
old_css = '''        #input-msg { flex: 1; min-width: 0; background: var(--panel); border: 1px solid var(--border); padding: 12px 16px; color: #FFF; font-size: 16px; border-radius: 20px; }\n        #input-msg:focus { outline: none; border-color: rgba(0, 255, 204, 0.4); }'''
new_css = '''        .ios-keyboard-proxy {\n            position: fixed;\n            top: calc(env(safe-area-inset-top) + 76px);\n            left: 50%;\n            width: 2px;\n            height: 2px;\n            min-width: 0;\n            opacity: 0.01;\n            padding: 0;\n            margin: 0;\n            border: 0;\n            background: transparent;\n            color: transparent;\n            caret-color: transparent;\n            font-size: 16px;\n            pointer-events: none;\n            z-index: -1;\n        }\n        .input-msg-display {\n            flex: 1;\n            min-width: 0;\n            min-height: 42px;\n            background: var(--panel);\n            border: 1px solid var(--border);\n            padding: 10px 16px;\n            color: #FFF;\n            font-size: 16px;\n            line-height: 20px;\n            border-radius: 20px;\n            white-space: nowrap;\n            overflow: hidden;\n            text-overflow: ellipsis;\n            cursor: text;\n            user-select: none;\n        }\n        .input-msg-display:empty::before { content: attr(data-placeholder); color: #8A8A92; }\n        .input-msg-display.focused { border-color: rgba(0, 255, 204, 0.4); }'''
if old_css not in s:
    raise SystemExit('input css block not found')
s = s.replace(old_css, new_css, 1)

# Replace existing VisualViewport script with clean height-only + proxy input sync.
start = s.find('    <script>\n        (function() {')
end = s.find('    </script>', start)
if start == -1 or end == -1:
    raise SystemExit('inline viewport script not found')
end += len('    </script>')
new_script = '''    <script>\n        (function() {\n            const root = document.documentElement;\n            const proxy = document.getElementById('input-msg');\n            const display = document.getElementById('input-msg-display');\n            const messages = document.getElementById('chat-messages');\n            const send = document.getElementById('btn-send');\n            let raf = 0;\n\n            function syncDisplay() {\n                display.textContent = proxy.value || '';\n            }\n\n            function applyViewportHeight() {\n                raf = 0;\n                const vv = window.visualViewport;\n                const height = Math.round(vv ? vv.height : window.innerHeight);\n                root.style.setProperty('--vv-height', `${height}px`);\n            }\n\n            function scheduleViewportHeight() {\n                if (raf) return;\n                raf = requestAnimationFrame(applyViewportHeight);\n            }\n\n            function focusKeyboard(e) {\n                if (e) e.preventDefault();\n                try { proxy.focus({ preventScroll: true }); } catch (_) { proxy.focus(); }\n                display.classList.add('focused');\n                scheduleViewportHeight();\n            }\n\n            display.addEventListener('pointerdown', focusKeyboard);\n            display.addEventListener('click', focusKeyboard);\n            proxy.addEventListener('input', syncDisplay);\n            proxy.addEventListener('focus', function() {\n                display.classList.add('focused');\n                scheduleViewportHeight();\n            });\n            proxy.addEventListener('blur', function() {\n                display.classList.remove('focused');\n                scheduleViewportHeight();\n            });\n\n            // app.js clears proxy.value after sending; refresh the visible shell after its handler runs.\n            send.addEventListener('click', function() { setTimeout(syncDisplay, 0); });\n            proxy.addEventListener('keydown', function(e) {\n                if (e.key === 'Enter' && !e.isComposing) setTimeout(syncDisplay, 0);\n            });\n\n            scheduleViewportHeight();\n            window.addEventListener('resize', scheduleViewportHeight, { passive: true });\n            window.addEventListener('orientationchange', scheduleViewportHeight, { passive: true });\n            if (window.visualViewport) {\n                window.visualViewport.addEventListener('resize', scheduleViewportHeight, { passive: true });\n            }\n        })();\n    </script>'''
s = s[:start] + new_script + s[end:]

s = s.replace('20260815-v26-visual-viewport-shell', '20260815-v27-ios-proxy-input', 1)
p.write_text(s)

# ---- app.js ----
p = Path('js/app.js')
a = p.read_text()
a = a.replace("document.getElementById('input-msg').addEventListener('keydown', function(e) {\n    if (e.key === 'Enter') sendMessage();\n});", "document.getElementById('input-msg').addEventListener('keydown', function(e) {\n    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {\n        e.preventDefault();\n        sendMessage();\n    }\n});", 1)
p.write_text(a)

from pathlib import Path

p = Path('index.html')
s = p.read_text()

old = '''    <script>
        (function() {
            const root = document.documentElement;
            const input = document.getElementById('input-msg');
            const messages = document.getElementById('chat-messages');

            function syncViewport() {
                const vv = window.visualViewport;
                const height = vv ? vv.height : window.innerHeight;
                const top = vv ? vv.offsetTop : 0;
                root.style.setProperty('--app-height', `${Math.round(height)}px`);
                root.style.setProperty('--app-top', `${Math.round(top)}px`);

                if (document.activeElement === input && messages) {
                    requestAnimationFrame(function() {
                        messages.scrollTop = messages.scrollHeight;
                    });
                }
            }

            syncViewport();
            window.addEventListener('resize', syncViewport, { passive: true });
            window.addEventListener('orientationchange', syncViewport, { passive: true });

            if (window.visualViewport) {
                window.visualViewport.addEventListener('resize', syncViewport, { passive: true });
                window.visualViewport.addEventListener('scroll', syncViewport, { passive: true });
            }

            input.addEventListener('focus', function() {
                setTimeout(syncViewport, 50);
                setTimeout(syncViewport, 250);
            });

            input.addEventListener('blur', function() {
                setTimeout(syncViewport, 50);
            });
        })();
    </script>'''

new = '''    <script>
        (function() {
            const root = document.documentElement;
            const input = document.getElementById('input-msg');
            const messages = document.getElementById('chat-messages');
            let viewportRaf = 0;
            let lastHeight = 0;
            let lastTop = 0;

            function applyViewport() {
                viewportRaf = 0;
                const vv = window.visualViewport;
                const height = Math.round(vv ? vv.height : window.innerHeight);
                const top = Math.round(vv ? vv.offsetTop : 0);

                if (height === lastHeight && top === lastTop) return;

                const bottomGap = messages
                    ? Math.max(0, messages.scrollHeight - messages.scrollTop - messages.clientHeight)
                    : 0;
                const keepAtBottom = document.activeElement === input && bottomGap < 96;

                lastHeight = height;
                lastTop = top;
                root.style.setProperty('--app-height', `${height}px`);
                root.style.setProperty('--app-top', `${top}px`);

                if (keepAtBottom && messages) {
                    requestAnimationFrame(function() {
                        messages.scrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight - bottomGap);
                    });
                }
            }

            function scheduleViewportSync() {
                if (viewportRaf) return;
                viewportRaf = requestAnimationFrame(applyViewport);
            }

            scheduleViewportSync();
            window.addEventListener('resize', scheduleViewportSync, { passive: true });
            window.addEventListener('orientationchange', scheduleViewportSync, { passive: true });

            if (window.visualViewport) {
                window.visualViewport.addEventListener('resize', scheduleViewportSync, { passive: true });
                window.visualViewport.addEventListener('scroll', scheduleViewportSync, { passive: true });
            }

            input.addEventListener('focus', function() {
                scheduleViewportSync();
            });

            input.addEventListener('blur', function() {
                scheduleViewportSync();
            });
        })();
    </script>'''

if old not in s:
    raise SystemExit('viewport block not found')

s = s.replace(old, new, 1)
s = s.replace('20260815-v20-fullscreen-keyboard', '20260815-v21-smooth-keyboard', 1)
p.write_text(s)

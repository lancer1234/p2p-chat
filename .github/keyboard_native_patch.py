from pathlib import Path
p=Path('index.html')
s=p.read_text()

# Remove custom keyboard variables/compensation.
s=s.replace('            --keyboard-height: 0px;\n','',1)
s=s.replace('            padding-bottom: calc(24px + var(--keyboard-height));\n','',1)
s=s.replace('            transform: translateY(calc(-1 * var(--keyboard-height)));\n            will-change: transform;\n','',1)
s=s.replace('            #chat-messages { padding: 16px 14px calc(16px + var(--keyboard-height)); gap: 12px; }','            #chat-messages { padding: 16px 14px; gap: 12px; }',1)

# Keep chat in normal fixed full-screen flex layout without JS moving it.
s=s.replace('            height: 100dvh;\n            background: var(--bg);', '            height: 100dvh;\n            min-height: 100dvh;\n            background: var(--bg);',1)
s=s.replace('        #chat-input-area {\n            flex: 0 0 auto;', '        #chat-input-area {\n            flex: 0 0 auto;\n            position: sticky;\n            bottom: 0;\n            z-index: 5;',1)

# Remove the inline visualViewport keyboard handler completely.
start=s.find('    <script>\n        (function() {')
if start != -1:
    end=s.find('    </script>', start)
    if end != -1:
        s=s[:start] + s[end+len('    </script>'):]

# Prevent Safari layout scroll from propagating through the document.
s=s.replace('html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: var(--bg); }',
'''html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: var(--bg); overscroll-behavior: none; }
        html { position: fixed; inset: 0; }
        body { position: fixed; inset: 0; width: 100%; height: 100%; }''',1)

s=s.replace('20260815-v24-keyboard-stable','20260815-v25-native-keyboard',1)
p.write_text(s)

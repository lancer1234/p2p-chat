from pathlib import Path
p=Path('index.html')
s=p.read_text()
s=s.replace(', interactive-widget=resizes-content','',1)
s=s.replace('            #chat-messages { padding: 16px 14px; gap: 12px; }','            #chat-messages { padding: 16px 14px calc(16px + var(--keyboard-height)); gap: 12px; }',1)
s=s.replace('20260815-v23-keyboard-inset','20260815-v24-keyboard-stable',1)
p.write_text(s)

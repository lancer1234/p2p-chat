from pathlib import Path

p = Path('js/nostr.js')
s = p.read_text()
s = s.replace('        if (connected && this.onAnyRelayConnected) {\n          this.onAnyRelayConnected(url, index);\n        }', '        if (connected && changed && this.onAnyRelayConnected) {\n          this.onAnyRelayConnected(url, index);\n        }', 1)
p.write_text(s)

p = Path('js/app.js')
a = p.read_text()
a = a.replace("function subscribeBackgroundSession(friendPk) {\n    const session = getBackgroundSession(friendPk);\n    nostr.subscribeToFriend(myKeyPair.pk, friendPk, async (rawContent, authorPk) => {", "function subscribeBackgroundSession(friendPk) {\n    const session = getBackgroundSession(friendPk);\n    if (session.subscribed) return;\n    const subscribed = nostr.subscribeToFriend(myKeyPair.pk, friendPk, async (rawContent, authorPk) => {", 1)
a = a.replace("    });\n    session.subscribed = true;\n}\n\nfunction startBackgroundSession", "    });\n    session.subscribed = !!subscribed;\n}\n\nfunction startBackgroundSession", 1)
p.write_text(a)

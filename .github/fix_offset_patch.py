from pathlib import Path
p=Path('index.html')
s=p.read_text()
s=s.replace("            top: var(--app-top);", "            top: 0;", 1)
s=s.replace("            let lastTop = 0;\n", "", 1)
s=s.replace("                const top = Math.round(vv ? vv.offsetTop : 0);\n\n                if (height === lastHeight && top === lastTop) return;", "                if (height === lastHeight) return;", 1)
s=s.replace("                lastTop = top;\n                root.style.setProperty('--app-height', `${height}px`);\n                root.style.setProperty('--app-top', `${top}px`);", "                root.style.setProperty('--app-height', `${height}px`);", 1)
s=s.replace("20260815-v21-smooth-keyboard", "20260815-v22-ios-offset-fix", 1)
p.write_text(s)

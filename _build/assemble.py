import pathlib, sys

root = pathlib.Path(__file__).resolve().parent
out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root.parent / "寝室公共开支智能记账与分摊提醒-demo.html"

css = (root / "style.css").read_text(encoding="utf-8")
body = (root / "body.html").read_text(encoding="utf-8")
js = (root / "app.js").read_text(encoding="utf-8")

html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="theme-color" content="#0d3b2d" />
<meta name="color-scheme" content="light" />
<title>寝账 · 寝室公共开支台账 demo</title>
<style>
{css}
</style>
</head>
<body>
{body}
<script>
{js}
</script>
</body>
</html>
"""
out.write_text(html, encoding="utf-8", newline="\n")
print("wrote", out, len(html), "chars")

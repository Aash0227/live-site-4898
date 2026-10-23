import fitz, re, sys, json
pdf = r"C:\4898_project\site-viewer\10510 MADERA DR, SARKAR RESIDENCE_CITY APPROVED SET_05 FEB 2026.pdf"
d = fitz.open(pdf)
kw = re.compile(r"(SITE PLAN|SURVEY|TOPOGRAPH|BOUNDARY|BENCHMARK|BENCH MARK|BASIS OF BEARING|N\s?\d{1,2}°|S\s?\d{1,2}°|FINISH(ED)? FLOOR|F\.?F\.?E|NAVD|NGVD|APN|LOT AREA|GRADING)", re.I)
out=[]
for i, p in enumerate(d):
    t = p.get_text()
    hits = sorted(set(m.group(0).upper() for m in kw.finditer(t)))
    # sheet id: look for patterns like A1.0, C-1, SU-1
    sid = re.findall(r"\b(?:[ACSELMPT][A-Z]?-?\d{1,2}\.\d{1,2}|SU-?\d|C-?\d\.?\d?|T-?\d\.\d)\b", t)
    out.append((i+1, len(t), hits, sid[:6]))
for r in out: print(r)

import fitz,math,collections,json
d=fitz.open(r'C:\4898_project\site-viewer\10510 MADERA DR, SARKAR RESIDENCE_CITY APPROVED SET_05 FEB 2026.pdf')
p=d[98]; M=p.rotation_matrix
R=fitz.Rect(100,700,1960,1600)
g=collections.defaultdict(list)
for dr in p.get_drawings():
    c=dr.get('color'); key=(tuple(round(x,2) for x in c) if c else None, round(dr.get('width') or 0,2), str(dr.get('dashes')), dr.get('type'))
    for it in dr['items']:
        pts=[q*M for q in it[1:] if isinstance(q,fitz.Point)]
        if pts and all(R.contains(q) for q in pts):
            g[key].append((it[0],[(round(q.x,1),round(q.y,1)) for q in pts]))
for k,v in sorted(g.items(), key=lambda kv:-len(kv[1]))[:25]:
    L=sum(math.dist(s[1][0],s[1][-1]) for s in v)
    print(k,len(v),round(L), collections.Counter(s[0] for s in v))
json.dump({str(k):v for k,v in g.items()}, open('c1_items.json','w'))

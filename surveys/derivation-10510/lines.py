import fitz,sys,math
d=fitz.open(r'C:\4898_project\site-viewer\10510 MADERA DR, SARKAR RESIDENCE_CITY APPROVED SET_05 FEB 2026.pdf')
pg=int(sys.argv[1]); minlen=float(sys.argv[2]); scale_ft_per_pt=float(sys.argv[3])
p=d[pg-1]; M=p.rotation_matrix
seen=set()
for dr in p.get_drawings():
    for it in dr['items']:
        if it[0]=='l':
            a,b=it[1]*M,it[2]*M
            L=math.hypot(b.x-a.x,b.y-a.y)
            if L>=minlen:
                k=(round(a.x),round(a.y),round(b.x),round(b.y))
                if k in seen: continue
                seen.add(k)
                print('line',k,'len_pt',round(L,1),'ft',round(L*scale_ft_per_pt,2),'dir cw from up',round(math.degrees(math.atan2(b.x-a.x,-(b.y-a.y)))%180,3), 'w',dr.get('width'), 'color',dr.get('color'), 'dashes', dr.get('dashes'))

import fitz,math,json
from PIL import Image, ImageDraw
d=fitz.open(r'C:\4898_project\site-viewer\10510 MADERA DR, SARKAR RESIDENCE_CITY APPROVED SET_05 FEB 2026.pdf')
p=d[5]
R=fitz.Rect(0,450,1800,1500)
im=Image.new("RGB",(900,525),'white'); dr=ImageDraw.Draw(im)
out={'red':[],'gray18':[],'black252':[]}
for D in p.get_drawings():
    if not R.intersects(D['rect']): continue
    c=D.get('color'); w=round(D.get('width') or 0,2)
    k=None
    if c and c[0]>0.9 and c[1]<0.1 and w==0.24 and D['type']=='s': k='red'; col='red'
    elif c and abs(c[0]-0.75)<0.01 and w==1.8: k='gray18'; col='blue'
    elif c and c[0]==0 and w==2.52: k='black252'; col='green'
    if not k: continue
    for it in D['items']:
        if it[0]=='l':
            a,b=it[1],it[2]; out[k].append([[a.x,a.y],[b.x,b.y]]); dr.line([(a.x/2,(a.y-450)/2),(b.x/2,(b.y-450)/2)],fill=col,width=2)
        elif it[0]=='c':
            a,b=it[1],it[4]; out[k].append([[a.x,a.y],[b.x,b.y]]); dr.line([(a.x/2,(a.y-450)/2),(b.x/2,(b.y-450)/2)],fill=col,width=2)
im.save('p6_cands.png'); json.dump(out,open('p6_items.json','w'))
print({k:len(v) for k,v in out.items()})

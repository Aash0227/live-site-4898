import json, math, numpy as np
FT=0.3048; S=10/72
it=json.load(open('p6_items.json'))
G=np.array([q for s in it['gray18'] for q in s])
ne6=np.array([G[:,0].max(), G[G[:,0]>1675][:,1].min()])
top=G[np.abs(G[:,1]-ne6[1])<5]; right=G[G[:,0]>1675]
se6=np.array([ne6[0], right[:,1].max()]); tip6=np.array([top[:,0].min(), ne6[1]])
cur=G[(np.abs(G[:,1]-ne6[1])>=5)&(G[:,0]<1675)]; cur=cur[np.argsort(-cur[:,0])]
def ft(P,ref): P=np.atleast_2d(P); return np.c_[(P[:,0]-ref[0])*S, -(P[:,1]-ref[1])*S]
poly6=ft(np.r_[[tip6],[ne6],[se6],cur],ne6)
x,y=poly6[:,0],poly6[:,1]; area=0.5*abs(x@np.roll(y,-1)-y@np.roll(x,-1))
print('p6 lot: rear',round(-poly6[0,0],2),'ft side',round(-poly6[2,1],2),'ft area',round(area,1),'sqft, pts',len(poly6))
# C1 curve vs p6 curve, both relative to their NE corner
c1=json.load(open('lot_sheet.json')); P1=np.array(c1['polySheetPt']); ne1=np.array(c1['ne'])
cur1=ft(P1[3:],ne1)
def segdist(P,poly):
    best=np.full(len(P),1e9)
    for a,b in zip(poly[:-1],poly[1:]):
        ab=b-a; t=np.clip(((P-a)@ab)/max(ab@ab,1e-12),0,1); q=a+t[:,None]*ab; best=np.minimum(best,np.linalg.norm(P-q,axis=1))
    return best
dd=segdist(cur1,poly6[2:])
print('C1 front curve vs A-1.003 front curve (NE corners aligned): median',round(float(np.median(dd)),2),'max',round(float(dd.max()),2),'ft')
H=np.array([q for s in it['red'] for q in s]); H=H[H[:,0]>1100]; Pk=ft(H,ne6)
osm=np.array([(-4.9,-2.7),(-9.1,5.0),(2.1,11.0),(10.7,-4.9),(4.5,-8.3),(4.3,-7.7),(3.3,-8.2),(4.5,-10.4),(-0.6,-13.2),(-4.1,-6.8),(-0.2,-4.7),(-2.1,-1.2),(-4.9,-2.7)])/FT
def xf(p,P):
    th,tx,ty=p; c,s=math.cos(th),math.sin(th); return P@np.array([[c,s],[-s,c]])+[tx,ty]
def cost(p): return float(np.mean(np.minimum(segdist(xf(p,Pk),osm),15)**2))
def nm(f,x0,step,it=600):
    n=len(x0); X=[np.array(x0,float)]+[np.array(x0,float)+np.eye(n)[i]*step[i] for i in range(n)]; F=[f(x) for x in X]
    for _ in range(it):
        o=np.argsort(F); X=[X[i] for i in o]; F=[F[i] for i in o]; c=np.mean(X[:-1],0)
        xr=c+(c-X[-1]); fr=f(xr)
        if fr<F[0]:
            xe=c+2*(c-X[-1]); fe=f(xe); X[-1],F[-1]=(xe,fe) if fe<fr else (xr,fr)
        elif fr<F[-2]: X[-1],F[-1]=xr,fr
        else:
            xc=c+0.5*(X[-1]-c); fc=f(xc)
            if fc<F[-1]: X[-1],F[-1]=xc,fc
            else: X=[X[0]+0.5*(x-X[0]) for x in X]; F=[f(x) for x in X]
    i=int(np.argmin(F)); return X[i],F[i]
th0=math.radians(-43.8211)
best=None
for dth in np.radians([-8,-4,0,4,8]):
    for tx in range(-150,1,25):
        for ty in range(-120,1,25):
            x,fv=nm(cost,[th0+dth,tx,ty],[0.03,5,5],200)
            if best is None or fv<best[1]: best=(x,fv)
x,fv=nm(cost,best[0],[0.005,1,1],800)
d=segdist(xf(x,Pk),osm)
print('free fit: sheet +x is',round(math.degrees(x[0]),3),'deg from east (bearing-implied -43.821); rms',round(math.sqrt(fv),2),'ft median',round(float(np.median(d)),2),'p90',round(float(np.percentile(d,90)),2),'n',len(d))
xb,fb=nm(lambda q: cost([th0,q[0],q[1]]),x[1:],[1,1],800)
d2=segdist(xf([th0,*xb],Pk),osm)
print('bearing-fixed fit: rms',round(math.sqrt(fb),2),'ft median',round(float(np.median(d2)),2),'t',xb)
json.dump({'poly6Ft':poly6.tolist(),'areaSqFt':area,'free':[*x],'fixed':[th0,*xb],'freeRmsFt':math.sqrt(fv),'fixedRmsFt':math.sqrt(fb),'origin':[37.330740712271,-122.059240183821]},open('tie.json','w'))

import json, math, numpy as np
FT=0.3048
T=json.load(open('tie.json')); th,tx,ty=T['fixed']; lat0,lon0=T['origin']
def m_per_deg(lat):
    p=math.radians(lat)
    return 111132.92-559.82*math.cos(2*p)+1.175*math.cos(4*p), 111412.84*math.cos(p)-93.5*math.cos(3*p)
mlat,mlon=m_per_deg(lat0)
NE_MODEL=np.array([85.554,73.436])
c,s=math.cos(th),math.sin(th); R=np.array([[c,-s],[s,c]])
def model_to_ll(p):
    sft=np.array(p[:2])-NE_MODEL; en=(R@sft+[tx,ty])*FT
    return lat0+en[1]/mlat, lon0+en[0]/mlon
poly=np.array(T['poly6Ft'])+NE_MODEL
# simplify the polygon: keep vertices whose removal changes the outline by > 0.05 ft (Douglas-Peucker)
def dp(P,eps):
    if len(P)<3: return P
    a,b=P[0],P[-1]; ab=b-a; n=np.linalg.norm(ab)
    d=np.abs(ab[0]*(P-a)[:,1]-ab[1]*(P-a)[:,0])/n if n>0 else np.linalg.norm(P-a,axis=1)
    i=int(np.argmax(d))
    return np.r_[dp(P[:i+1],eps)[:-1],dp(P[i:],eps)] if d[i]>eps else np.array([a,b])
closed=np.r_[poly,[poly[0]]]
simp=dp(closed,0.1)[:-1]
x,y=simp[:,0],simp[:,1]; area=0.5*abs(x@np.roll(y,-1)-y@np.roll(x,-1))
print('lot vertices',len(poly),'->',len(simp),'area',round(area,1))
stem_c=[46.6373,33.43985]
bc=model_to_ll(stem_c)
def dist(a,b): return math.hypot((a[0]-b[0])*mlat,(a[1]-b[1])*mlon)
print('building (stem-wall) centre',bc,'from Esri',round(dist(bc,(lat0,lon0)),2),'m, Nominatim',round(dist(bc,(37.3307581,-122.0592421)),2),'m, Census',round(dist(bc,(37.330472121366,-122.059186416638)),2))
lc=model_to_ll([poly[:,0].mean(),poly[:,1].mean()])
# existing house centroid (OSM) vs Esri
osm=np.array([(-4.9,-2.7),(-9.1,5.0),(2.1,11.0),(10.7,-4.9),(4.5,-8.3),(4.3,-7.7),(3.3,-8.2),(4.5,-10.4),(-0.6,-13.2),(-4.1,-6.8),(-0.2,-4.7),(-2.1,-1.2)])
print('OSM 10510 building vertex mean EN m',osm.mean(0).round(2))
out={'modelTie':{'modelFt':stem_c,'lat':bc[0],'lon':bc[1]},'lotPolygonModelFt':[[round(a,3),round(b,3)] for a,b in simp],'lotCornersLatLon':[[round(v,8) for v in model_to_ll(p)] for p in simp],'areaSqFt':area,'neCornerModelFt':NE_MODEL.tolist(),'neLatLon':model_to_ll(NE_MODEL)}
json.dump(out,open('geo_out.json','w'),indent=1)
print('NE corner',out['neLatLon'])

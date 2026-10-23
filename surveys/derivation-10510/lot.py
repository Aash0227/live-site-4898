import json, math, numpy as np
g=json.load(open('c1_items.json'))
red=[pts for k,v in g.items() if ', 2.04,' in k and '(0.0, 0.0, 0.0)' in k for t,pts in v]
blue=[pts for k,v in g.items() if ', 1.68,' in k and '(0.0, 0.0, 0.0)' in k for t,pts in v]
FT=10/72   # 1" = 10'
P=np.array([q for s in red for q in s]); P=P[P[:,1]>=790]
top=P[P[:,1]<810]; right=P[P[:,0]>1900]
print('top y range',top[:,1].min(),top[:,1].max(),'x',top[:,0].min(),top[:,0].max())
print('right x',right[:,0].min(),right[:,0].max(),'y',right[:,1].min(),right[:,1].max())
# front curve points: not top, not right side
cur=P[(P[:,1]>=810)&(P[:,0]<1900)]
cur=cur[np.argsort(cur[:,0])]
tip=np.array([top[:,0].min(), top[:,1].mean()]); ne=np.array([1908.0, top[:,1].mean()]); se=np.array([1908.0, right[:,1].max()])
poly=[tip,ne,se]+[c for c in cur[::-1]]
poly=np.array(poly)
x,y=poly[:,0]*FT,-poly[:,1]*FT
area=0.5*abs(np.dot(x,np.roll(y,-1))-np.dot(y,np.roll(x,-1)))
print('drawn rear',(ne[0]-tip[0])*FT,'right',(se[1]-ne[1])*FT,'area sqft',round(area,1),'curve pts',len(cur))
# front curve length
L=sum(np.linalg.norm(np.diff(np.r_[[se],cur[::-1],[tip]],axis=0),axis=1))*FT
print('front length ft',round(L,2))
B=np.array([q for s in blue for q in s])
print('building walls bbox sheet pt',B.min(0),B.max(0),'ft',(B.max(0)-B.min(0))*FT)
print('building bbox relative to NE corner (ft, x right, y up):', (B.min(0)[0]-ne[0])*FT,(B.max(0)[0]-ne[0])*FT, -(B.max(0)[1]-ne[1])*FT, -(B.min(0)[1]-ne[1])*FT)
json.dump({'polySheetPt':poly.tolist(),'ne':ne.tolist(),'buildingBBoxPt':[B.min(0).tolist(),B.max(0).tolist()]},open('lot_sheet.json','w'))

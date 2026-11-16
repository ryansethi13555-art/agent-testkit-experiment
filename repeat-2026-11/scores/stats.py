import json,glob,sys,statistics as st
V='/mnt/project-files/moneyinvariant-writeup/v2/corpus/'
k=json.load(open(V+'classification.json'))
mut=json.load(open(V+'corpus.json'))['mutants']
c={m['id']:m for m in mut}; order=[m['id'] for m in mut]
H=[i for i in order if c[i].get('split')=='holdout' and k[i]['category']=='money']
M=[i for i in order if k[i]['category']=='money']
EQ=[i for i in order if k[i]['category']=='equivalent']
NE=[i for i in order if k[i]['category']!='equivalent']
usage={'A1':(218127,30,768190),'A2':(251753,36,912089),'A3':(237326,33,953507),'B1':(228946,30,532179),'B2':(261950,37,988217),'B3':(260316,53,1326877),'C1':(260096,68,2187558),'C2':(215820,40,834841),'C3':(254474,58,2035350)}
runs=['A1','A2','A3','B1','B2','B3','C1','C2','C3']
out={}
for r in runs:
    cases={}; stable=None
    for f in glob.glob(f'out/{r}.s*of*.json'):
        d=json.load(open(f)); cases.update(d['cases']); stable=d['stablePassing']
    det=[i for i in order if i in cases and cases[i]['detected']]
    rep=[i for i in det if cases[i].get('reproduced',0)>=1 and len(cases[i]['runs'])>1 and all(x['failingStable'] or x.get('timedOut') for x in cases[i]['runs'])]
    out[r]=dict(n=len(cases),stable=stable,h=len(set(det)&set(H)),m=len(set(det)&set(M)),ne=len(set(det)&set(NE)),fa=[i for i in det if i in EQ],all=len(det),rep=len(rep),rep_h=len(set(rep)&set(H)),tok=usage[r][0],tools=usage[r][1],mins=round(usage[r][2]/60000,1),hset=[i for i in H if i in det])
    print(r,{x:y for x,y in out[r].items() if x!='hset'})
for g in 'ABC':
    v=[out[g+str(i)]['h'] for i in (1,2,3) if out[g+str(i)]['n']==150]
    print(g,'primary',v,'mean',round(st.mean(v),2) if v else None,'range',(min(v),max(v)) if v else None)
json.dump({'H':H,'runs':out},open('out/stats.json','w'),indent=1)

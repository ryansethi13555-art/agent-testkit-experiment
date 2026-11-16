import json,glob,sys
V='/mnt/project-files/moneyinvariant-writeup/v2/corpus/'
k=json.load(open(V+'classification.json'))
c={m['id']:m for m in json.load(open(V+'corpus.json'))['mutants']}
H=[i for i in c if c[i].get('split')=='holdout' and k[i]['category']=='money']
M=[i for i in c if k[i]['category']=='money']
assert len(H)==31 and len(M)==41,(len(H),len(M))
det={}
for run in sys.argv[1:]:
    cases={}
    for f in glob.glob(f'out/{run}.s*of*.json'):
        cases.update(json.load(open(f))['cases'])
    assert len(cases)==150,(run,len(cases))
    det[run]={i for i,v in cases.items() if v['detected']}
    d=det[run]
    cat=lambda n:sum(1 for i in d if k[i]['category']==n)
    to=sum(1 for v in cases.values() if any(r.get('timedOut') for r in v['runs']))
    print(run,'holdout money',len(d&set(H)),'/31 | all',len(d),'/150 | money41',len(d&set(M)),'| val',cat('validation'),'avail',cat('availability'),'equiv',cat('equivalent'),'other',cat('other'),'| timedOut cases',to)
json.dump({r:sorted(v) for r,v in det.items()},open('out/detected_sets.json','w'))

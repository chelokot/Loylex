#!/usr/bin/env python3
"""Recognition when the root boundary is already supplied (different task)."""
import collections,csv,gzip,json
from analyze import HERE,load,compute

def main():
    out=HERE/'results';data=HERE.parents[1]/'data/russian-prefix-research'
    morphs,*_=load(data);pairs=set();root_morphs={}
    with gzip.open(out/'lemma_families.csv.gz','rt',encoding='utf-8-sig') as h:
        for row in csv.DictReader(h):
            for parts in morphs[row['word']]:
                root=next(s for s,t,a,b in parts if t=='ROOT')
                pairs.add((root,row['family']))
                root_morphs[root]=[[(root,'ROOT',0,len(root))]]
    _,stats=compute('root_signatures',pairs,root_morphs,out)
    (out/'root_summary.json').write_text(json.dumps(stats,ensure_ascii=False,indent=2)+'\n')

if __name__=='__main__':main()

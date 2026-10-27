#!/usr/bin/env python3
"""One output row per modeled family, retaining every member and all signatures."""
import collections,csv,gzip,statistics
from analyze import HERE

def main():
    groups=collections.defaultdict(list)
    with gzip.open(HERE/'results/lemma_families.csv.gz','rt',encoding='utf-8-sig') as h:
        for row in csv.DictReader(h):groups[row['family']].append(row)
    with gzip.open(HERE/'results/family_summary.csv.gz','wt',encoding='utf-8-sig',newline='') as h:
        writer=csv.writer(h);writer.writerow(['family','members','root_variants','member_count','mean_word_letters','mean_prefix_letters_when_solvable','min_prefix_letters','max_prefix_letters','unsolvable','distinct_signatures'])
        for family,rows in sorted(groups.items()):
            ks=[int(r['prefix_letters']) for r in rows if r['prefix_letters']]
            writer.writerow([family,' | '.join(r['word'] for r in rows),' | '.join(sorted({r['roots'] for r in rows})),len(rows),statistics.mean(int(r['word_letters']) for r in rows),statistics.mean(ks) if ks else '',min(ks) if ks else '',max(ks) if ks else '',len(rows)-len(ks),' | '.join(sorted({r['prefix'] for r in rows if r['prefix']}))])
    print('Exported',len(groups),'modeled families')

if __name__=='__main__':main()

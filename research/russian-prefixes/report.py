#!/usr/bin/env python3
"""Offline scientific report: Matplotlib PDF/PNG plus a self-contained HTML explorer."""
import csv,gzip,json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
import numpy as np
from analyze import HERE
P=HERE/'results'; A=HERE/'artifacts';A.mkdir(exist_ok=True)
S=json.loads((P/'summary.json').read_text());I=json.loads((P/'inflections_summary.json').read_text());E=json.loads((P/'extra_summary.json').read_text());R=json.loads((P/'root_summary.json').read_text());L=I['lemma_families'];F=I['inflected_forms']
with gzip.open(P/'lemma_families.csv.gz','rt',encoding='utf-8-sig') as h:ROWS=list(csv.DictReader(h))
from report_style import BG,INK,MUT,GREEN,ORANGE,GOLD,GRID,BLUE,num,dec,tx,para,page,clean,card,save

with PdfPages(A/'russian-word-signatures.pdf',metadata={'Title':'Сколько букв достаточно?','Author':'Loylex','Subject':'Воспроизводимый эксперимент по различению русских корневых семейств'}) as pdf:
 f=page(1,'Сколько букв достаточно?','Минимальное начало, различающее корневое семейство. Модельная оценка, а не перепись всего русского языка.')
 card(f,.075,.777,.25,.13,dec(F['mean_prefix']), 'буквы в среднем · словоформы')
 card(f,.375,.777,.25,.13,num(L['spellings']), 'исходных написаний')
 card(f,.675,.777,.25,.13,num(L['families']), 'группы в основной модели')
 ax=f.add_axes([.09,.225,.53,.365]);clean(ax)
 for data,label,col in [(L,'Исходный словник',GREEN),(F,'Словоформы',ORANGE)]:
  ax.plot([p['k'] for p in data['within']],[p['pct'] for p in data['within']],color=col,lw=3,marker='o',ms=4,label=label)
 ax.set(xlim=(1,12),ylim=(0,103),xlabel='Сколько первых букв прочитано',ylabel='Доля записей с однозначным семейством, %');ax.legend(frameon=False,loc='lower right')
 tx(f,.68,.58,'5 букв',22,GREEN,'bold');para(f,.68,.535,f"различают {dec(L['within'][4]['pct'],1)}% исходных записей; после 7 букв — {dec(L['within'][6]['pct'],1)}%.",30)
 tx(f,.68,.423,'Корень ≠ ответ',19,ORANGE,'bold');para(f,.68,.38,'Иногда хватает части корня. Иногда нужны приставка, суффикс или сигнал конца слова.',30)
 para(f,.075,.144,f"Обработано {num(F['spellings'])} различных написаний словоформ. Средние длины посчитаны только там, где различающее начало существует. Все проценты — от всех записей соответствующего набора. Семейства определены алгоритмически; у части корней нет надёжного омонимического ID.",116,10)
 f.savefig(A/'overview.png',dpi=170);save(pdf,f)

 f=page(2,'Твои примеры — и точное правило','Двигаемся слева направо. Останавливаемся, когда все словарные продолжения принадлежат одному семейству.')
 tx(f,.08,.766,'к р а с',28,MUT);tx(f,.39,.766,'→',28,MUT);tx(f,.47,.766,'к р а с н',28,GREEN,'bold');tx(f,.77,.766,'5 букв',24,GREEN,'bold')
 para(f,.08,.694,'«крас» ещё допускает «красивый» и «краска». В принятой модели «красн» уже выделяет семейство красного. Красная, красные и красный дают один результат.',108)
 tx(f,.08,.594,'м р а',28,MUT);tx(f,.39,.594,'→',28,MUT);tx(f,.47,.594,'м р а ч',28,GREEN,'bold');tx(f,.77,.594,'4 буквы',24,GREEN,'bold')
 para(f,.08,.522,'«мра» допускает «мрамор» и «мразь». «мрач» различает мрачность, мрачный и мрачнеть. Варианты «мрак/мрач» связаны по словарю чередований.',108)
 ax=f.add_axes([.08,.267,.84,.155]);ax.axis('off')
 table=ax.table(cellText=[['красный / красная / красные','красн','5 / 7, 7, 7'],['мрачность / мрачный / мрачнеть','мрач','4 / 9, 7, 8'],['кот','нет без конца слова','3 буквы целого слова']],colLabels=['Слово / формы','Минимальное начало','Сегмент / длина слова'],cellLoc='left',colLoc='left',loc='center',colWidths=[.50,.28,.22]);table.auto_set_font_size(False);table.set_fontsize(10);table.scale(1,2.05)
 for (r,c),cell in table.get_celld().items():cell.set_edgecolor(BG);cell.set_facecolor('#dfe9df' if r==0 else '#ebece4')
 para(f,.08,.19,'Важно: минимальность зависит от словаря. Если убрать «красивый» и все остальные крас-конкуренты, потребуется меньше букв. Это задача о словарных продолжениях, а не измерение того, как человек угадывает слово из контекста.',110,11)
 save(pdf,f)

 f=page(3,'Начало информативнее окончания','Одинаковые веса у записей словаря; частотность реальной речи здесь не используется.')
 ax=f.add_axes([.09,.42,.55,.345]);clean(ax)
 xs=list(range(2,14));ax.bar([x-.19 for x in xs],[L['prefix_distribution'].get(str(x),0)/L['rows']*100 for x in xs],width=.37,color=GREEN,label='Семейство')
 ind=E['individual_words'];ax.bar([x+.19 for x in xs],[ind['prefix_distribution'].get(str(x),0)/ind['rows']*100 for x in xs],width=.37,color=ORANGE,label='Точное написание')
 ax.set(xlabel='Длина минимального начала, букв',ylabel='% от всех записей',xticks=xs);ax.legend(frameon=False)
 tx(f,.7,.75,dec(L['mean_prefix']),34,GREEN,'bold');tx(f,.7,.69,'буквы → семейство',12)
 tx(f,.7,.615,dec(ind['mean_prefix']),34,ORANGE,'bold');tx(f,.7,.555,'буквы → точное написание',12)
 tx(f,.7,.48,dec(L['mean_suffix']),34,BLUE,'bold');tx(f,.7,.42,'буквы с конца → семейство',12)
 para(f,.09,.309,f"Медиана различающего начала — {dec(L['median_prefix'],0)} букв; 90-й процентиль среди разрешимых записей — {L['p90_prefix']}. Средняя полная длина — {dec(L['mean_letters'])} буквы. В разрешимых случаях в среднем остаются непрочитанными {dec(L['mean_saved'])} буквы.",105,13,INK)
 para(f,.09,.17,'Сравнение средних условное: у каждого режима собственный набор разрешимых записей. У точного написания больше случаев, когда нужен сигнал окончания. Сравнение показывает свойства этих словарей, а не универсальное преимущество чтения слева направо.',114,10)
 save(pdf,f)

 f=page(4,'Граница корня редко является оптимальной','Сопоставление минимального начала с морфемным разбором исходной записи. Только слова с одним размеченным корнем и найденным ответом.')
 rel=L['root_relations'];keys=['before_root_end','exact_root','prefix_plus_root','after_root_end'];vals=[rel[k] for k in keys];total=sum(vals)
 ax=f.add_axes([.08,.36,.43,.39]);colors=[GREEN,GOLD,BLUE,ORANGE]
 wedges,_=ax.pie(vals,colors=colors,startangle=90,wedgeprops=dict(width=.26,edgecolor=BG,linewidth=3));ax.text(0,.1,num(total),ha='center',va='center',fontsize=23,fontweight='bold',color=INK);ax.text(0,-.19,'записей в сравнении',ha='center',fontsize=10,color=MUT)
 labels=['Остановиться до конца корня','Сегмент в точности равен корню','Приставка + целый корень','Прочитать дальше корня']
 for j,(label,value,col) in enumerate(zip(labels,vals,colors)):
  y=.737-j*.087;tx(f,.565,y,f'{100*value/total:.1f}%'.replace('.',','),21,col,'bold');tx(f,.68,y-.008,label,11)
 para(f,.09,.25,'Равенство «минимальное начало = корень» возможно только у слова без приставки. У приставочного слова можно дойти до правой границы корня, но прочитанный сегмент включает и приставку.',111,12,INK)
 para(f,.09,.137,f"Случаи без ответа ({num(rel['no_prefix'])}) и неоднозначные/многокоренные разборы ({num(rel['unknown_or_multiple_roots'])}) не включены в круг. Если заранее дать границу самого корня, отдельный эксперимент на корневых вариантах даёт среднее {dec(R['mean_prefix'])} буквы среди разрешимых вариантов; это другая выборка и другая задача.",115,10)
 save(pdf,f)

 f=page(5,'Словоформы: почти 1,8 миллиона проверок','Формы порождены только из известных словарных разборов pymorphy3 / OpenCorpora. Неизвестные слова нейросетью не достраивались.')
 card(f,.075,.775,.25,.13,num(F['spellings']),'уникальных написаний форм')
 card(f,.375,.775,.25,.13,dec(F['mean_prefix']),'буквы · разрешимые записи')
 card(f,.675,.775,.25,.13,dec(F['solved_pct'],2)+'%','разрешимы по началу')
 tx(f,.09,.58,'Неоднозначность бывает двух видов',19,INK,'bold')
 para(f,.09,.522,f"1. Нужно знать, что слово закончилось: {num(F['eof_only'])} записей. Например, после «мама» ещё возможна «мамалыга». Пробел разрешает эту неоднозначность.",103,13)
 para(f,.09,.402,f"2. Совпало полное написание разных групп: {num(F['homograph_unresolved'])} записей. Ни следующая буква, ни пробел не помогут: нужен контекст или исправление ошибочной группировки.",103,13)
 para(f,.09,.272,f"Для развёртки нашлось {num(F['matched_seed_lemmas'])} исходных словарных лемм. Формы остальных записей не гарантируются. Нормализация пересопоставила {num(L['inflection_assignments_changed'])} исходных написаний; у {num(L['no_known_normal_form_in_seed'])} не найдено известной нормальной формы внутри исходного набора.",111,11)
 para(f,.09,.14,'Среднее по словоформам сильнее взвешивает слова с большими парадигмами. Поэтому сдвиг среднего относительно исходного словника нельзя целиком приписать добавлению конкурентов. Это не частотность речи.',114,10)
 save(pdf,f)

 f=page(6,'Число семейств зависит от определения','Единственного автоматического разбиения на «всё однокоренное» нет: составное слово может относиться сразу к нескольким корням.')
 models=[('Основная: первый корень + IDs + формы',L),('Только написание первого корня',S['first_root']),('Все корни как упорядоченный набор',S['surface_roots']),('Гнёзда Тихонова, пересечение',S['tikhonov_nests']),('Большая сеть DeriNet.RU, фильтр',S['derinet_broad'])]
 ax=f.add_axes([.075,.45,.85,.28]);ax.axis('off')
 data=[[name,num(s['spellings']),num(s['families']),dec(s['mean_prefix']),dec(s['solved_pct'],1)+'%'] for name,s in models]
 t=ax.table(cellText=data,colLabels=['Модель','Написаний','Групп','Среднее*','Разрешимо'],colWidths=[.47,.14,.13,.12,.14],loc='center',cellLoc='left',colLoc='left');t.auto_set_font_size(False);t.set_fontsize(9.5);t.scale(1,2.3)
 for (r,c),cell in t.get_celld().items():cell.set_edgecolor(BG);cell.set_facecolor('#dfe9df' if r==0 else '#ebece4')
 para(f,.09,.352,'Лесовоз связан с лесом и с возить. Если транзитивно склеивать все слова, у которых есть хотя бы один общий корень, через такие мостики возникают большие семантически разнородные компоненты. Основной расчёт поэтому выбирает первый корень; альтернативный сохраняет весь набор.',110,12,INK)
 para(f,.09,.19,'DeriNet.RU: 337 632 исходные записи; убраны 113 919 записей с заглавными буквами, затем схлопнуты повторы. Фильтр не убирает все имена, опечатки и ошибки лемматизации. Гнёзда — неполный набор преимущественно продуктивных семейств, а не уменьшенная перепись языка.',115,10)
 para(f,.09,.09,'* Все средние только по разрешимым записям. Эти модели различаются и словником, и качеством связей; разницу нельзя трактовать как доверительный интервал.',115,9)
 save(pdf,f)

 f=page(7,'Ещё три наблюдения','Размер словаря, длина слова и перегруженные начала меняют порог различимости.')
 ax=f.add_axes([.09,.445,.37,.31]);clean(ax);sz=S['dictionary_size'];ax.plot([s['dictionary_rows']/1000 for s in sz],[s['mean_finite'] for s in sz],marker='o',color=GREEN,lw=3)
 ax.set(xlabel='Размер словаря, тыс. записей',ylabel='Средняя длина начала, букв',title='Больше конкурентов → позже ответ')
 ax=f.add_axes([.575,.445,.34,.31]);clean(ax);bins=E['length_bins'];xx=np.arange(len(bins));ax.bar(xx,[b['mean_word'] for b in bins],color=GRID,label='Полное слово');ax.bar(xx,[b['mean_prefix'] for b in bins],color=ORANGE,label='Минимальное начало');ax.set(xticks=xx,xticklabels=[b['label'] for b in bins],xlabel='Длина полного слова, букв',ylabel='Средняя длина, букв');ax.legend(frameon=False,fontsize=9)
 para(f,.09,.365,'Слева: фиксированные 2 000 целевых записей и вложенные случайные словари (seed 1648); модель — полный набор поверхностных корней. Неразрешимых целей: от 26 до 55. Изменение среднего не заменяет проверку каждой отдельной записи.',113,10)
 top=E['ambiguous_prefixes']['4'][:4]
 tx(f,.09,.252,'Где дольше всего тесно',17,INK,'bold')
 for j,item in enumerate(top):
  x=.09+j*.217;tx(f,x,.202,item['prefix'],23,GREEN,'bold');tx(f,x,.155,f"{num(item['families'])} групп",11,MUT)
 para(f,.09,.095,'Количество разных семейств среди продолжений данного четырёхбуквенного начала в основном словнике. Это не частота употребления.',112,9)
 save(pdf,f)

 f=page(8,'Что доказано — и где граница точности','Алгоритм точно решает задачу для заданного словника и заданных меток. Лингвистическая истинность самих меток не гарантируется.')
 tx(f,.08,.76,'Воспроизводимость',17,GREEN,'bold')
 para(f,.08,.714,'Дерево продолжений проверено полным перебором на случайных словарях. Для 1,8 млн форм используется независимый алгоритм на сортировке: он сверяется с деревом. Для каждой записи сохранён конкурент, подтверждающий невозможность остановиться раньше.',109,11)
 tx(f,.08,.59,'Главные ограничения',17,ORANGE,'bold')
 unresolved=S['audit']['mapped_assignment']['unmapped_or_homonymous_variant']
 para(f,.08,.545,f"Нет замкнутого списка всех современных русских слов. Основа морфемного набора — словарь Тихонова; свежие термины покрыты неполно. У {num(unresolved)} исходных разборов при построении модели нет разрешённого ID варианта: метка R — техническое объединение по написанию первого корня, а не доказанная общность происхождения. Метки K используют Кузнецову: они местами этимологические и могут объединять уже разошедшиеся современные семьи.",111,11)
 para(f,.08,.365,'Ё приравнена к е, ударения сняты, регистр приведён к нижнему. Дефис участвует в различении, но не считается буквой. Числа взвешены по записям (написание, семейство), а не по словам в живой речи. Две явно указанные словарные записи добавлены к размеченному релизу: красный и мрачность. Уверенность человека и распознавание в контексте не измерялись.',111,10)
 tx(f,.08,.235,'Источники',15,GREEN,'bold')
 sources=[('RuMorphs-Lemmas / морфемы','https://cmc-msu-ai.github.io/NLPDatasets/'),('Кузнецова / корни и чередования','https://github.com/tabidots/ru_roots'),('Тихонов / оцифрованные гнёзда','https://github.com/mashashaitz/Russian-Derinet'),('DeriNet.RU / UDer v1.1','https://hdl.handle.net/11234/1-3247'),('pymorphy3 / словари OpenCorpora','https://pypi.org/project/pymorphy3/')]
 for j,(label,url) in enumerate(sources):tx(f,.085,.194-j*.024,label+'  ·  '+url,8.5,MUT,url=url)
 save(pdf,f)

from explorer import build_explorer
build_explorer(ROWS,A/'overview.png',A/'explorer.html')
print('Created PDF, overview PNG, and offline HTML explorer')

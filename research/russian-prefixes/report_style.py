"""Shared typography, page layout and palette for the scientific PDF."""
import textwrap
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
from analyze import HERE
A=HERE/'artifacts'
BG='#f6f2e9';INK='#172b2c';MUT='#61706c';GREEN='#137b65';ORANGE='#e87544';GOLD='#dab151';GRID='#d9ded4';BLUE='#4d78a8'
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':11,'text.color':INK,'axes.labelcolor':INK,'xtick.color':MUT,'ytick.color':MUT,'axes.edgecolor':GRID,'axes.spines.top':False,'axes.spines.right':False,'figure.facecolor':BG,'axes.facecolor':BG,'savefig.facecolor':BG,'axes.titleweight':'bold','axes.titlelocation':'left','pdf.fonttype':42})

def num(n):return f'{n:,}'.replace(',',' ')
def dec(n,d=2):return f'{n:.{d}f}'.replace('.',',')
def tx(fig,x,y,t,size=12,color=INK,weight=None,**kw):return fig.text(x,y,t,fontsize=size,color=color,fontweight=weight,va='top',**kw)
def para(fig,x,y,t,width=85,size=11,color=MUT):return tx(fig,x,y,textwrap.fill(t,width),size,color,linespacing=1.5)
def page(n,title,subtitle):
 f=plt.figure(figsize=(12,9));tx(f,.065,.958,'ЛОЙЛЕКС / ЛАБОРАТОРИЯ ЯЗЫКА',9,GREEN,'bold');tx(f,.935,.958,f'{n:02} / 08',9,MUT,ha='right')
 tx(f,.065,.905,title,27,INK,'bold');para(f,.065,.847,subtitle,110,11)
 tx(f,.065,.035,'РУССКИЕ СЛОВА · КОНЕЧНЫЙ СЛОВАРЬ · 27 ОКТЯБРЯ 2026',8,MUT)
 return f

def clean(ax):
 ax.spines[['top','right']].set_visible(False);ax.grid(axis='y',color=GRID,alpha=.6);ax.set_axisbelow(True)
def card(f,x,y,w,h,value,label,color=GREEN):
 f.add_artist(FancyBboxPatch((x,y-h),w,h,boxstyle='round,pad=0.012,rounding_size=0.012',transform=f.transFigure,facecolor='#e8ede3',edgecolor='none',zorder=0))
 tx(f,x+.018,y-.015,value,29,color,'bold');tx(f,x+.018,y-.079,label,10,MUT)
def save(pdf,f):
 f.savefig(A/f'page-{pdf.get_pagecount()+1}.png',dpi=90)
 pdf.savefig(f);plt.close(f)

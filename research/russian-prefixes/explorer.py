"""Build the self-contained searchable HTML artifact from computed rows."""
import base64,gzip,json
from pathlib import Path

FIELDS=['word','family','word_letters','prefix','prefix_letters','roots','competitor','morphemes','root_relation','needs_end_marker']

def build_explorer(rows,overview_path,output_path):
    payload=base64.b64encode(gzip.compress(json.dumps([[r[k] for k in FIELDS] for r in rows],ensure_ascii=False,separators=(',',':')).encode(),mtime=0)).decode()
    png=base64.b64encode(overview_path.read_bytes()).decode()
    template=(Path(__file__).resolve().parent/'explorer_template.html').read_text()
    output_path.write_text(template.replace('PACKEDDATA',payload).replace('PNGDATA',png))

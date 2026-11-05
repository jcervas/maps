import json,os,re

head=open('build/page.head.html').read()
body=open('build/page.body.html').read()
js=open('build/page.js').read()

css=re.search(r'<style>(.*?)</style>', head, re.S).group(1)
assert '--mm-ink' in css and '.mm-root' in css
assert re.search(r'(?m)^body\{', css) is None, 'a bare body rule would restyle the site'
for bad in ['.wrap{','.wrap ',' .wrap']:
    assert bad not in css, 'unnamespaced .wrap in css: '+bad

SITE_TOKENS = """
/* Served inside the site: take the host's tokens so this page follows the
   site's palette and its light/dark toggle exactly. Tokens with no host
   equivalent (--mm-dem, --mm-nodata, --mm-faint, --mm-line2) keep the values
   set above, which already flip under [data-theme="dark"]. */
.mm-root{
  --mm-ink:var(--ink); --mm-muted:var(--muted); --mm-line:var(--line);
  --mm-surface:var(--bg); --mm-surface2:var(--bg-alt);
  --mm-accent:var(--red); --mm-accent-dark:var(--red-dark); --mm-gop:var(--red);
}
"""
open('build/map.css','w').write(css.strip()+"\n"+SITE_TOKENS)

# description feeds <meta name="description">; summary is the maps-index card text.
FM = ('---\n'
 'layout: default\n'
 'title: The Map Politics Forgot\n'
 'description: "An interactive map of the 206 lower-48 Nielsen television markets and the '
 'congressional districts they cut across, with the 2022, 2024 and 2026 lines side by side."\n'
 'summary: "Half the country lives in a television market that straddles a state line, and '
 'half of all congressional districts are split across two or more."\n'
 '---\n\n')
frag=(FM
 + '<link rel="stylesheet" href="{{ \'/maps/media-markets/map.css\' | relative_url }}">\n'
 + '<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>\n'
 + '<script src="https://cdnjs.cloudflare.com/ajax/libs/topojson/3.0.2/topojson.min.js"></script>\n\n'
 + body + '\n')
cdt=json.load(open('cdall.topo.json'))
frag += ("<script>\nconst DATA="+open('dma_data.json').read()
 +";\nconst TOPO="+open('dma.topo.json').read()
 +";\nconst STATES="+open('states.topo.json').read()
 +";\nconst CDTOPO="+json.dumps(cdt,separators=(',',':'))
 +";\nconst CDL="+open('cd_layer.json').read()
 +";\n</script>\n<script>\n"+js+"\n</script>\n")
open('build/index.html','w').write(frag)

liquid=re.findall(r'\{\{.*?\}\}|\{%.*?%\}', frag, re.S)
assert liquid==["{{ '/maps/media-markets/map.css' | relative_url }}"], liquid
print('map.css    %s bytes' % f"{os.path.getsize('build/map.css'):,}")
print('index.html %s bytes' % f"{os.path.getsize('build/index.html'):,}")
print('liquid tags:',len(liquid))

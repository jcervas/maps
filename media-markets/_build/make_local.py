import os,re
src=open('media-markets.html').read()
d3=open('lib_d3.js').read(); tp=open('lib_topo.js').read()

# swap the two CDN script tags for inlined libraries
src=src.replace('<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>',
                '<script>'+d3+'</script>',1)
src=src.replace('<script src="https://cdnjs.cloudflare.com/ajax/libs/topojson/3.0.2/topojson.min.js"></script>',
                '<script>'+tp+'</script>',1)
assert 'cdnjs.cloudflare.com/ajax/libs/d3' not in src
assert 'cdnjs.cloudflare.com/ajax/libs/topojson' not in src

# the wrapper the artifact platform normally supplies
SHELL = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="An interactive map of U.S. television media markets and the congressional districts they cut across, 2022 to 2026.">
<style>
:root{color-scheme:light dark;
  padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
body{margin:0}
img{max-width:100%}
[hidden]{display:none!important}
</style>
"""
out = SHELL + src.split('\n',0)[0] + "\n</head>\n<body>\n" if False else None
# head content = everything up to the first element of the page body
i = src.index('<div class="mm-root">')
head, body = src[:i], src[i:]
doc = SHELL + head + "</head>\n<body>\n" + body + "\n</body>\n</html>\n"
open('media-markets.local.html','w').write(doc)
print('standalone bytes', f"{os.path.getsize('media-markets.local.html'):,}")
for must in ['[hidden]{display:none!important}','<meta charset="utf-8">','<title>','d3.min','national-cd']:
    print(' ',must, must in doc or must=='d3.min')

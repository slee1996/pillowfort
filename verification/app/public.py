"""Read-only production contracts. Run from the checkout root: python3 verification/app/public.py OUTPUT."""
import base64
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen

APP, SITE, MCP = ('https://pillowfort.xyz', 'https://about.pillowfort.xyz', 'https://mcp.pillowfort.xyz')
source = json.loads(Path('server.json').read_text())
version = source['version']
report = {}


def fetch(url, body=None, headers=None):
    request = Request(url, data=None if body is None else json.dumps(body).encode(), headers={'User-Agent': 'Pillowfort-Release-Acceptance/1', **(headers or {})})
    try:
        response = urlopen(request, timeout=12)
    except HTTPError as error:
        response = error
    with response:
        return response.status, response.headers, response.read()


def ok(url):
    code, headers, data = fetch(url)
    assert code == 200, f'{urlsplit(url).path}: HTTP {code}'
    return headers, data


def run(name, fn):
    try:
        report[name] = {'status': 'pass', 'observed': fn()}
    except Exception as error:
        report[name] = {'status': 'fail', 'reason': str(error) or type(error).__name__}


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.assets, self.canonical = [], None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'link' and a.get('rel') == 'canonical':
            self.canonical = a.get('href')
        if tag == 'script' and a.get('type') == 'module' and a.get('src'):
            self.assets.append(a['src'])
        if tag == 'link' and a.get('rel') == 'stylesheet':
            self.assets.append(a['href'])


def shell():
    headers, doc = ok(APP + '/')
    assert headers.get('X-Content-Type-Options') == 'nosniff'
    page = Links(); page.feed(doc.decode())
    assert len(page.assets) >= 2
    assets = {}
    for path in page.assets:
        if urlsplit(path).netloc: continue  # Provider-injected analytics are not application assets.
        assert path.startswith('/assets/'), path
        _, data = ok(APP + path)
        assert data
        assets[path] = hashlib.sha256(data).hexdigest()
    assert any(x.endswith('.js') for x in assets) and any(x.endswith('.css') for x in assets)
    ah, _ = ok(APP + '/activity')
    assert "frame-ancestors 'none'" in headers['Content-Security-Policy'] and 'frame-ancestors https://discord.com' in ah['Content-Security-Policy']
    return {'assetsSha256': assets, 'rootFramePolicy': headers['Content-Security-Policy'], 'activityFramePolicy': ah['Content-Security-Policy']}


def sitemap(origin):
    headers, data = ok(origin + '/sitemap.xml')
    assert 'xml' in headers.get_content_type()
    root = ET.fromstring(data)
    assert root.tag == '{http://www.sitemaps.org/schemas/sitemap/0.9}urlset'
    urls = [n.text for n in root.findall('{*}url/{*}loc')]
    assert len(urls) == len(set(urls)) and origin + '/' in urls
    for url in urls:
        assert urlsplit(url).netloc == urlsplit(origin).netloc and url.startswith('https:')
        h, text = ok(url); assert h.get_content_type() == 'text/html'
        if origin == SITE:
            parsed = Links(); parsed.feed(text.decode()); assert parsed.canonical and parsed.canonical.rstrip('/') == url.rstrip('/'), f'canonical mismatch at {url}'
    return {'pages': len(urls), 'paths': [urlsplit(url).path for url in urls]}


def robots(origin):
    _, data = ok(origin + '/robots.txt')
    assert b'User-agent:' in data or b'User-Agent:' in data
    maps = re.findall(r'^Sitemap:\s*(\S+)',data.decode(),flags=re.I|re.M)
    local = [u for u in maps if u.split('?',1)[0] == origin+'/sitemap.xml']
    assert local, 'No same-origin sitemap directive in the served response'
    for u in local:
        assert ET.fromstring(ok(u)[1]).findall('{*}url/{*}loc'), 'Advertised sitemap has no pages'
    return maps


def publication():
    n = source['name']; reg = 'https://registry.modelcontextprotocol.io/v0.1/servers/'+quote(n, safe='')+'/versions/latest'
    registry = json.loads(ok(reg)[1])['server']; assert all(registry[k] == source[k] for k in ('name','version','title','websiteUrl','icons','remotes'))
    assert ok(registry['icons'][0]['src'])[0].get_content_type() == 'image/svg+xml'
    npm = json.loads(ok('https://registry.npmjs.org/@ontologic%2fpillowfort-agent/latest')[1]); assert npm['version'] == version
    raw = ok(npm['dist']['tarball'])[1]; sri = 'sha512-' + base64.b64encode(hashlib.sha512(raw).digest()).decode(); assert sri == npm['dist']['integrity']
    mirrored = ok(SITE+f'/downloads/pillowfort-agent-{version}.tgz')[1]; assert mirrored == raw
    return {'version': version, 'npmSri': sri, 'mirrorBytes': len(raw), 'registryIconTitleWebsite': True}


def catalog():
    app = json.loads(ok(APP+'/agents-release.json')[1]); about = json.loads(ok(SITE+'/agents/release.json')[1]); assert app == about and app['version'] == version
    full = json.loads(ok(SITE+'/agents/tools.json')[1]); focus = json.loads(ok(SITE+'/agents/collaboration-tools.json')[1]); names = lambda t: {row['name'] for row in t['tools']}
    assert names(focus) < names(full) and names(full) == names(json.loads(Path('docs/agents/tools.json').read_text()))
    return {'version': version, 'fullToolNames': len(names(full)), 'focusedToolNames': len(names(focus))}


def discovery():
    pre = json.loads(ok(MCP+'/preflight')[1]); rev = pre['mcp']['protocolVersion']; assert pre['participantAllocated'] is False
    def rpc(method, params):
        meta = {'io.modelcontextprotocol/protocolVersion': rev, 'io.modelcontextprotocol/clientInfo': {'name':'release-acceptance','version':'1'}, 'io.modelcontextprotocol/clientCapabilities': {}}
        return fetch(MCP+'/mcp', {'jsonrpc':'2.0','id':1,'method':method,'params':{**params,'_meta':meta}}, {'Content-Type':'application/json','Accept':'application/json, text/event-stream','MCP-Protocol-Version':rev,'Mcp-Method':method, **({'Mcp-Name':params['name']} if 'name' in params else {})})
    code, headers, data = rpc('server/discover',{}); assert code==200 and not headers.get('Mcp-Session-Id') and json.loads(data)['result']['resultType']=='complete'
    code, _, data = rpc('tools/list',{}); assert code==200
    tools = {t['name'] for t in json.loads(data)['result']['tools']}; assert {'session_create','room_next_event','ttt_move'} <= tools
    code, h, _ = rpc('tools/call',{'name':'session_list','arguments':{}}); assert code==401 and h.get('WWW-Authenticate')
    oauth = json.loads(ok(MCP+'/.well-known/oauth-authorization-server')[1]); assert 'S256' in oauth['code_challenge_methods_supported']; protected = json.loads(ok(MCP+'/.well-known/oauth-protected-resource/mcp')[1]);assert oauth['issuer'] in protected['authorization_servers']
    return {'protocol':rev,'anonymousToolCount':len(tools),'anonymousCall':code,'oauthPkce':True}


def cms():
    h, login = ok(SITE+'/admin'); assert 'noindex' in h['X-Robots-Tag'] and b'password' in login.lower()
    exposed = json.loads(ok(SITE+'/api/agent')[1])['capabilities']; assert len(exposed)>0
    return {'publicCapabilities':len(exposed),'editorServesLogin':True}


def fort_pass():
    v=json.loads(ok(APP+'/api/fort-pass/status')[1]);assert v['checkoutConfigured'] is True and v['priceLabel'];return {k:v[k] for k in ('checkoutConfigured','priceLabel')}


run('production web shell and asset identity', shell)
for origin in (APP,SITE):
    run(f'{origin} sitemap and canonical pages',lambda: sitemap(origin))
    run(f'{origin} robots advertises sitemap',lambda: robots(origin))
run('npm, Registry and marketing mirror integrity',publication)
run('release manifests and full/focused catalogs',catalog)
run('anonymous MCP discovery, protected calls and OAuth metadata',discovery)
run('public CMS discovery and private editor landing',cms)
run('Fort Pass availability (not fulfillment)',fort_pass)
for guide in ('index','workflows','security','reference'):
    run(f'public {guide} guide',lambda: len(ok(SITE+f'/agents/{guide}.md')[1]))
for origin in (APP,SITE,MCP):
    run(f'{origin} telemetry health',lambda: ok(origin+'/.well-known/telemetry-health')[0].get('Cache-Control'))
Path(sys.argv[1]).write_text(json.dumps(report,indent=2)+'\n')
for k,v in report.items(): print(v['status'],k,v.get('reason',''))
sys.exit(any(r['status']=='fail' for r in report.values()))

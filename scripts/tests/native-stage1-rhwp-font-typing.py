#!/usr/bin/env python3
"""P0 native HWP/HWPX acceptance: real RHWP ribbon, caret restore, IBus, T009 save and reopen."""
import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time
import traceback
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
for folder in ('tests/e2e', 'tests/integration/rhwp'):
    sys.path.insert(0, str(ROOT / folder))
import tauri_smoke as smoke
import rhwp_poc

spec = importlib.util.spec_from_file_location('new_document_acceptance', ROOT / 'scripts/tests/native-new-document.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

SAMPLE = '한글 ABC'
ORIGINAL = '한글 Mixed text 끝 end'
FIRST_PARA = 0
FONT_SIZE = '[data-command="format.fontSize"] select'
SVG = '{http://www.w3.org/2000/svg}'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def status(d):
    return d.js("const e=document.querySelector('[data-testid=rhwp-status]');return e?{...e.dataset}:null") or {}


def wait_status(a, predicate, description, timeout=30):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = status(a.d)
        if predicate(last):
            return last
        time.sleep(.1)
    raise smoke.Failure(f'timed out waiting for {description}: {last!r}')


def current_size(d):
    return d.js('return document.querySelector(arguments[0])?.value ?? null', FONT_SIZE)


def canvas_png(d):
    data = d.js("return document.querySelector('.rhwp-page__canvas')?.toDataURL('image/png') ?? null")
    if not data or not data.startswith('data:image/png;base64,'):
        raise smoke.Failure('RHWP page canvas is not rendered')
    return base64.b64decode(data.split(',', 1)[1])


def canvas_sha(d):
    return hashlib.sha256(canvas_png(d)).hexdigest()


def wait_canvas(d, predicate, description, timeout=10):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = canvas_sha(d)
        if predicate(last):
            return last
        time.sleep(.1)
    raise smoke.Failure(f'timed out waiting for {description}: {last!r}')


def ime_canvas_metrics(d, stage, reference):
    return d.js("""const c=document.querySelector('.rhwp-page__canvas'), ctx=c?.getContext('2d'), page=c?.getBoundingClientRect();
      const caret=document.querySelector('[data-testid=rhwp-caret]')?.getBoundingClientRect();
      if(!c||!ctx||!page||!caret)return {error:'canvas or caret unavailable'};
      const pixels=ctx.getImageData(0,0,c.width,c.height).data, sx=c.width/page.width, sy=c.height/page.height;
      const box=(data,x0,y0,x1,y1,pred)=>{let l=1e9,t=1e9,r=-1,b=-1,n=0;
        for(let y=Math.max(0,Math.floor(y0));y<Math.min(c.height,Math.ceil(y1));y++)for(let x=Math.max(0,Math.floor(x0));x<Math.min(c.width,Math.ceil(x1));x++){
          const i=(y*c.width+x)*4,lum=.299*data[i]+.587*data[i+1]+.114*data[i+2];if(pred(i,lum)){l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);n++;}}
        return n?{left:l,top:t,right:r,bottom:b,width:r-l+1,height:b-t+1,pixels:n}:null;};
      const reference=arguments[1], first=box(pixels,(reference.x-1)*sx,(reference.y-15)*sy,
        (reference.x+16)*sx,(reference.y+4)*sy,(i,lum)=>lum<190);
      const anchorX=(caret.left-c.getBoundingClientRect().left)*sx, anchorY=(caret.top-c.getBoundingClientRect().top)*sy;
      if(arguments[0]==='begin'){
        window.__s1ImePixels={data:new Uint8ClampedArray(pixels),width:c.width,height:c.height,anchorX,anchorY,first};
        return {width:c.width,height:c.height,scaleX:sx,scaleY:sy,anchorX,anchorY,baselineFirstGlyph:first};
      }
      const base=window.__s1ImePixels;if(!base||base.width!==c.width||base.height!==c.height)return {error:'baseline canvas changed dimensions'};
      if(arguments[0]==='restore'){
        const restored=box(pixels,base.anchorX-2,base.anchorY-8,base.anchorX+80*sx,base.anchorY+35*sy,(i,lum)=>{
          const before=.299*base.data[i]+.587*base.data[i+1]+.114*base.data[i+2];
          return Math.abs(before-lum)>35||Math.abs(base.data[i+1]-pixels[i+1])>35||Math.abs(base.data[i+2]-pixels[i+2])>35;
        });
        return {changedPixels:restored?.pixels??0,changedBounds:restored,region:'composition glyph area at insertion caret'};
      }
      const x0=base.anchorX-2,y0=base.anchorY-8,x1=base.anchorX+Math.max(80*sx,base.width*.04),y1=base.anchorY+35*sy;
      const added=box(pixels,x0,y0,x1,y1,(i,lum)=>{
        const before=.299*base.data[i]+.587*base.data[i+1]+.114*base.data[i+2];
        return before>245&&lum<220&&Math.abs(before-lum)>35;
      });
      return {width:c.width,height:c.height,scaleX:sx,scaleY:sy,baselineReferenceGlyph:base.first,compositionAddedGlyph:added};""", stage, reference)


def choose_size(a, size):
    d = a.d
    rect = d.js("const r=document.querySelector(arguments[0])?.getBoundingClientRect();return r?[r.left+r.width/2,r.top+r.height/2]:null", FONT_SIZE)
    if not rect:
        raise smoke.Failure('RHWP Ribbon font-size picker missing')
    rhwp_poc.click(d, *rect)
    focused = d.js('return document.activeElement===document.querySelector(arguments[0])', FONT_SIZE)
    if not focused:
        raise smoke.Failure('font-size picker did not receive focus')
    a.key(*list(str(size)), 'Return')
    selected = current_size(d)
    method = 'native select keyboard'
    if selected != str(size):
        # WebKitGTK can expose the native popup without type-ahead; dispatch the same React change handler.
        d.js("const s=document.querySelector(arguments[0]);if(!s)return false;"
             "const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;"
             "set.call(s,arguments[1]);s.dispatchEvent(new Event('change',{bubbles:true}));return true", FONT_SIZE, str(size))
        method = 'focused select change event'
    a.wait('return document.querySelector(arguments[0])?.value===arguments[1]', FONT_SIZE, str(size), timeout=15)
    return {'sizePt': size, 'selectionMethod': method}


def click_caret(d):
    rect = d.js("const r=document.querySelector('[data-testid=rhwp-caret]')?.getBoundingClientRect();"
                "return r?[r.left+r.width/2,r.top+r.height/2]:null")
    if not rect:
        raise smoke.Failure('rendered RHWP caret missing')
    rhwp_poc.click(d, *rect)


def inspect_saved(path, out):
    raw = subprocess.check_output(['node', str(ROOT / 'scripts/tests/stage1-rhwp-font-typing-inspect.mjs'), str(path)], cwd=ROOT, text=True)
    result = json.loads(raw)
    p = result['paragraphs'][FIRST_PARA]
    if not p['text'].endswith(SAMPLE) or p['text'] != ORIGINAL + SAMPLE:
        raise smoke.Failure(f'saved RHWP text changed or reordered: {p["text"]!r}')
    start = len(ORIGINAL)
    original_sizes = [c['properties']['fontSize'] for c in p['characters'][:start]]
    sample_sizes = [c['properties']['fontSize'] for c in p['characters'][start:start + len(SAMPLE)]]
    if original_sizes != [1000] * len(ORIGINAL):
        raise smoke.Failure(f'original characters changed from 10 pt: {original_sizes!r}')
    if sample_sizes != [2400] * len(SAMPLE):
        raise smoke.Failure(f'inserted characters are not serialized at 24 pt: {sample_sizes!r}')
    reference = result['paragraphs'][1]
    if reference['text'] != 'Second paragraphㅎ' or any(c['properties']['fontSize'] != 1000 for c in reference['characters']):
        raise smoke.Failure(f'10 pt reference paragraph was changed: {reference!r}')
    svg_root = ET.parse(result['render']['svgPath']).getroot()
    glyphs = []
    for element in svg_root.iter(SVG + 'text'):
        text = ''.join(element.itertext())
        if text:
            try:
                size = float(element.attrib['font-size'])
            except (KeyError, ValueError):
                raise smoke.Failure(f'rendered glyph is missing a numeric font-size: {element.attrib!r}')
            glyphs.extend({'text': char, 'fontSizePx': size} for char in text)
    rendered_sample = [g for g in glyphs if g['fontSizePx'] >= 30]
    rendered_visible_text = ''.join(g['text'] for g in rendered_sample)
    expected_visible_text = ''.join(char for char in SAMPLE if not char.isspace())
    if rendered_visible_text != expected_visible_text or len(rendered_sample) != len(expected_visible_text):
        raise smoke.Failure(f'engine SVG does not render the appended text at 24 pt scale: {rendered_sample!r}')
    result['serialized'] = {'originalCharacterSizes100thPt': original_sizes,
                            'insertedCharacterSizes100thPt': sample_sizes,
                            'zipOrCfbInputBytes': path.stat().st_size}
    result['render']['sampleGlyphs'] = rendered_sample
    result['render']['sampleVisibleText'] = rendered_visible_text
    (out / f'{path.suffix[1:]}-serialized-render.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def scenario(a, args, fmt, report):
    path = args.out / 'docs' / f'stage1-font-typing.{fmt}'
    source = args.fixtures / f'{fmt}-stage1-caret' / f'original.{fmt}'
    if not source.is_file():
        raise smoke.Failure(f'missing Release-WASM fixture: {source}')
    generated = json.loads(subprocess.check_output(['node', str(ROOT / 'scripts/tests/stage1-rhwp-font-typing-inspect.mjs'),
                                                     '--add-reference', str(source), str(path)], cwd=ROOT, text=True))
    fixture = json.loads(subprocess.check_output(['node', str(ROOT / 'scripts/tests/stage1-rhwp-font-typing-inspect.mjs'),
                                                   str(path)], cwd=ROOT, text=True))
    reference_para = fixture['paragraphs'][1]
    if reference_para['text'] != 'Second paragraphㅎ' or reference_para['characters'][-1]['properties']['fontSize'] != 1000:
        raise smoke.Failure(f'10 pt reference glyph fixture is invalid: {reference_para!r}')
    fixture_svg = ET.parse(fixture['render']['svgPath']).getroot()
    reference_nodes = [e for e in fixture_svg.iter(SVG + 'text') if ''.join(e.itertext()) == 'ㅎ']
    if len(reference_nodes) != 1:
        raise smoke.Failure(f'expected one isolated 10 pt reference glyph in fixture SVG, found {len(reference_nodes)}')
    reference_node = reference_nodes[0]
    reference_glyph = {'x': float(reference_node.attrib['x']), 'y': float(reference_node.attrib['y']),
                       'fontSizePx': float(reference_node.attrib['font-size']), 'modelSize100thPt': 1000}
    row = {'format': fmt, 'fixtureSha256': sha(path), 'fixtureGeneration': generated,
           'referenceGlyphSvg': reference_glyph, 'stages': []}
    report['formats'].append(row)
    # Use the in-product path field so WebKitGTK's native chooser timing cannot obscure the edit test.
    # Opening and saving are still real app operations over the copied on-disk document.
    try:
        a.open(fmt, path)
    except Exception:
        try:
            row['openFailureDiagnostic'] = {
                'path': str(path.resolve()),
                'pathField': a.d.js("return document.querySelector('#document-path')?.value ?? null"),
                'tabs': a.d.js("return [...document.querySelectorAll('.document-tab__select')].map(e=>({text:e.textContent,state:e.dataset.state,selected:e.getAttribute('aria-selected')}))"),
                'status': status(a.d),
            }
            a.d.screenshot(args.out / f'{fmt}-open-failure.png')
        except Exception as diagnostic_error:
            row['openFailureDiagnosticError'] = str(diagnostic_error)
        raise
    a.wait('return document.activeElement?.classList.contains("rhwp-input")===true')
    a.d.js(rhwp_poc.EVENT_LOG)
    opened_canvas = canvas_sha(a.d)
    (args.out / f'{fmt}-opened.png').write_bytes(canvas_png(a.d))

    # Position at the end of the first 10 pt paragraph by document model offsets.
    a.engine('xkb:us::eng')
    a.key('ctrl+Home')
    wait_status(a, lambda s: s.get('caret') == '0:0:0', 'first paragraph start')
    a.key(*(['Right'] * len(ORIGINAL)))
    collapsed = wait_status(a, lambda s: s.get('caret') == f'0:0:{len(ORIGINAL)}',
                            'collapsed caret at end of original 10 pt paragraph')
    if current_size(a.d) != '10':
        raise smoke.Failure(f'fixture caret is not 10 pt: {current_size(a.d)!r}')
    caret_key = collapsed['caret']
    row['baseline'] = {'caret': caret_key, 'effectiveFontSizePt': int(current_size(a.d)),
                       'openedCanvasSha256': opened_canvas}

    row['setPendingSize'] = choose_size(a, 24)
    pending = wait_status(a, lambda s: s.get('caret') == caret_key and current_size(a.d) == '24', 'pending 24 pt at collapsed caret')
    baseline_canvas = canvas_sha(a.d)
    click_caret(a.d)
    restored = wait_status(a, lambda s: s.get('caret') == caret_key, 'same-caret pointer focus restore')
    if current_size(a.d) != '24':
        raise smoke.Failure(f'same-caret focus restore lost pending 24 pt: {current_size(a.d)!r}')
    row['focusReturn'] = {'sameCaret': restored['caret'] == caret_key, 'effectiveFontSizePt': 24}

    # Real caret navigation must invalidate the one-shot pending value; returning to the old offset does not revive it.
    a.key('Left')
    moved = wait_status(a, lambda s: s.get('caret') == f'0:0:{len(ORIGINAL)-1}', 'deliberate caret move')
    if current_size(a.d) != '10':
        raise smoke.Failure(f'deliberate navigation unexpectedly retained pending size: {current_size(a.d)!r}')
    a.key('Right')
    returned = wait_status(a, lambda s: s.get('caret') == caret_key, 'return after deliberate caret move')
    if current_size(a.d) != '10':
        raise smoke.Failure(f'pending size revived after deliberate navigation: {current_size(a.d)!r}')
    row['deliberateNavigation'] = {'movedTo': moved['caret'], 'returnedTo': returned['caret'], 'stalePendingRevived': False}

    row['setPendingSizeAfterNavigation'] = choose_size(a, 24)
    wait_status(a, lambda s: s.get('caret') == caret_key and current_size(a.d) == '24', 'second pending 24 pt')
    click_caret(a.d)
    wait_status(a, lambda s: s.get('caret') == caret_key and current_size(a.d) == '24', 'second same-caret focus restore')
    a.d.js("document.querySelector('.editor__scroll textarea.rhwp-input')?.focus()")
    a.wait('return document.activeElement?.classList.contains("rhwp-input")===true')
    if status(a.d).get('caret') != caret_key or current_size(a.d) != '24':
        raise smoke.Failure('restoring RHWP input focus changed the caret or pending font size')
    ime_baseline_canvas = canvas_sha(a.d)
    (args.out / f'{fmt}-ime-baseline.png').write_bytes(canvas_png(a.d))
    ime_baseline = ime_canvas_metrics(a.d, 'begin', reference_glyph)
    if not ime_baseline.get('baselineFirstGlyph'):
        raise smoke.Failure(f'could not measure the original 10 pt rendered reference glyph: {ime_baseline!r}')

    # Cancellation keeps pending formatting; then Hangul is produced by actual IBus, Latin by the X11 keyboard.
    a.engine('xkb:us::eng')
    a.engine('hangul')
    a.type('g')
    time.sleep(.35)
    composing = status(a.d)
    if composing.get('composing') != 'true':
        raise smoke.Failure(f'IBus Hangul preedit did not begin: {composing!r}')
    preedit_canvas = canvas_sha(a.d)
    preedit_metrics = ime_canvas_metrics(a.d, 'measure', reference_glyph)
    deadline = time.monotonic() + 5
    while not preedit_metrics.get('compositionAddedGlyph') and time.monotonic() < deadline:
        time.sleep(.1)
        preedit_metrics = ime_canvas_metrics(a.d, 'measure', reference_glyph)
    (args.out / f'{fmt}-ime-preedit.png').write_bytes(canvas_png(a.d))
    glyph = preedit_metrics.get('compositionAddedGlyph')
    baseline_glyph = ime_baseline['baselineFirstGlyph']
    if not glyph or glyph['height'] < baseline_glyph['height'] * 1.8:
        raise smoke.Failure(f'Hangul preedit is not visibly rendered at the selected 24 pt scale: '
                            f'{preedit_metrics!r}, pendingValue={current_size(a.d)!r}')
    row['imePreedit'] = {'status': composing, 'events': a.d.js('return window.__imeLog'),
                         'canvasSha256': preedit_canvas, 'ribbonValueDuringComposition': current_size(a.d),
                         'renderMetrics': preedit_metrics,
                         'glyphHeightRatioToSameGlyph10Pt': round(glyph['height'] / baseline_glyph['height'], 3)}
    # BackSpace removes the active Hangul jamo; End closes the native empty composition boundary.
    # This is the RHWP cancellation path used by the existing X11 IME acceptance probe.
    a.key('BackSpace', 'End')
    cancelled = wait_status(a, lambda s: s.get('composing') == 'false',
                            'cancelled IBus composition')
    cancelled_canvas = canvas_sha(a.d)
    cancel_raster = ime_canvas_metrics(a.d, 'restore', reference_glyph)
    deadline = time.monotonic() + 5
    while cancel_raster.get('changedPixels') != 0 and time.monotonic() < deadline:
        time.sleep(.1)
        cancelled_canvas = canvas_sha(a.d)
        cancel_raster = ime_canvas_metrics(a.d, 'restore', reference_glyph)
    (args.out / f'{fmt}-ime-cancelled.png').write_bytes(canvas_png(a.d))
    cancel_events = a.d.js('return window.__imeLog')
    row['imeCancellationObservation'] = {'status': cancelled, 'events': cancel_events,
                                         'canvasBefore': ime_baseline_canvas, 'canvasAfter': cancelled_canvas,
                                         'emptyCompositionEnd': any(e[0] == 'compositionend' and e[3] == 0 for e in cancel_events),
                                         'canvasRestored': cancel_raster.get('changedPixels') == 0,
                                         'canvasChangedPixelsNearInsertion': cancel_raster,
                                         'fullPageCanvasHashEqual': cancelled_canvas == ime_baseline_canvas,
                                         'canvasMatchesOpenedDocument': cancelled_canvas == opened_canvas,
                                         'documentRevisionUnchanged': cancelled.get('revision') == '0' and cancelled.get('localRevision') == '0'
                                         and cancelled.get('dirty') == 'false' and cancelled.get('caret') == caret_key}
    if not row['imeCancellationObservation']['emptyCompositionEnd'] or not row['imeCancellationObservation']['documentRevisionUnchanged'] \
            or not row['imeCancellationObservation']['canvasRestored'] \
            or not row['imeCancellationObservation']['fullPageCanvasHashEqual'] \
            or not row['imeCancellationObservation']['canvasMatchesOpenedDocument']:
        raise smoke.Failure(f'cancelled IME composition did not restore the full rendered document and model state: '
                            f'{row["imeCancellationObservation"]!r}')
    if current_size(a.d) != '24':
        raise smoke.Failure(f'composition cancellation discarded pending 24 pt: {current_size(a.d)!r}')
    row['imeCancellation'] = {'compositionStarted': True, 'emptyCompositionEnded': True,
                              'documentRevisionUnchanged': True, 'pendingFontSizePt': 24}

    a.type('gksrmf')
    time.sleep(.5)
    a.engine('xkb:us::eng')
    a.type(' ABC')
    typed = wait_status(a, lambda s: s.get('composing') == 'false' and int(s.get('localRevision', '0')) > 0
                        and current_size(a.d) == '24', 'committed native Hangul and Latin text', timeout=30)
    typed_canvas = canvas_sha(a.d)
    if typed_canvas == ime_baseline_canvas:
        raise smoke.Failure('committed IBus and Latin input did not change the rendered document')
    events = a.d.js('return window.__imeLog')
    if not any(e[0] == 'compositionstart' for e in events) or not any(e[0] == 'compositionend' for e in events):
        raise smoke.Failure(f'actual IBus composition events were not observed: {events!r}')
    row['nativeIme'] = {'status': 'PASS', 'input': SAMPLE, 'trustedInputPath': 'X11 xdotool → private IBus Hangul → WebKitGTK',
                        'events': events, 'renderedCanvasSha256': typed_canvas, 'effectiveFontSizePt': int(current_size(a.d))}

    # The same model snapshot is observed through the real Ribbon after selecting the inserted characters.
    a.key(*(['shift+Left'] * len(SAMPLE)))
    selected = wait_status(a, lambda s: bool(s.get('selection')), 'select appended sample')
    if current_size(a.d) != '24':
        raise smoke.Failure(f'sample selection does not show its effective 24 pt model value: {selected!r}, {current_size(a.d)!r}')
    selection_points = selected['selection'].split('|')
    offsets = [int(point.split(':')[2].split('@')[0]) for point in selection_points]
    if len(offsets) != 2 or max(offsets) - min(offsets) != len(SAMPLE):
        raise smoke.Failure(f'actual selection is not exactly the appended sample: {selected["selection"]!r}')
    row['selectedModel'] = {'selection': selected['selection'], 'effectiveFontSizePt': 24, 'selectedCharacterCount': len(SAMPLE)}
    a.key('Right')
    wait_status(a, lambda s: not s.get('selection'), 'collapse after sample inspection')

    # Replace the actual selected sample once, then Undo/Redo/Undo it. The saved document remains the
    # acceptance string while native selection replacement and its history boundary are exercised.
    a.key(*(['shift+Left'] * len(SAMPLE)))
    wait_status(a, lambda s: bool(s.get('selection')), 'reselect the appended sample for replacement')
    a.engine('xkb:us::eng')
    a.type('X')
    replacement_canvas = wait_canvas(a.d, lambda h: h != typed_canvas, 'selected text replacement changes the page')
    if replacement_canvas == typed_canvas or current_size(a.d) != '24':
        raise smoke.Failure('native replacement did not update the selected sample at 24 pt')
    a.key('ctrl+z')
    wait_canvas(a.d, lambda h: h == typed_canvas, 'Undo restores selected sample after replacement')
    a.key('ctrl+y')
    wait_canvas(a.d, lambda h: h == replacement_canvas, 'Redo restores native selection replacement')
    a.key('ctrl+z')
    wait_canvas(a.d, lambda h: h == typed_canvas, 'final Undo restores the acceptance sample')
    row['selectionReplacement'] = {'selectedCharacters': len(SAMPLE), 'replacement': 'X',
                                   'undoRedoUndoRestoredAcceptanceCanvas': True}

    # The exact native history grouping is engine-owned. One Undo must alter the committed page and
    # one Redo must restore the same rendered result; the independent save oracle checks all six chars.
    a.key('ctrl+z')
    wait_canvas(a.d, lambda h: h != typed_canvas, 'Undo changes the committed native input')
    a.key('ctrl+y')
    wait_canvas(a.d, lambda h: h == typed_canvas, 'Redo restores the committed native input pixels')
    redone_key = f'0:0:{len(ORIGINAL) + len(SAMPLE)}'
    redone_selection = f'{redone_key}|0:0:{len(ORIGINAL)}'
    redone = wait_status(a, lambda s: current_size(a.d) == '24' and
                         (s.get('caret') == redone_key or s.get('selection') == redone_selection),
                         'Redo restores the appended sample, its selection state, and 24 pt size')
    if current_size(a.d) != '24':
        raise smoke.Failure(f'Redo did not restore 24 pt typing model: {current_size(a.d)!r}')
    restored_selection = redone.get('selection') == redone_selection
    if restored_selection:
        # Undo/Redo correctly restores the selection owned by the previous replacement transaction.
        # Collapse it explicitly before save/reopen acceptance of the completed sample.
        a.key('Right')
        redone = wait_status(a, lambda s: s.get('caret') == redone_key and not s.get('selection'),
                             'collapse the restored sample selection at its end')
    row['history'] = {'undoChangedCommittedInput': True, 'redoRestoredCommittedCanvas': True,
                      'effectiveFontSizePt': 24, 'caret': redone['caret'],
                      'replacementSelectionRestoredByInputUndoRedo': restored_selection}

    row['save'] = a.save(fmt)
    row['savedSha256'] = sha(path)
    row['savedFileInspection'] = inspect_saved(path, args.out)
    old_session = next((s for s in a.sessions() if s['displayName'] == path.name), None)
    if not old_session:
        raise smoke.Failure(f'RHWP session missing before reopen: {path.name}')
    if not rhwp_poc.close_tab(a.d, path.name):
        raise smoke.Failure(f'saved RHWP requested discard on close: {path.name}')
    a.open(fmt, path)
    new_session = next((s for s in a.sessions() if s['displayName'] == path.name), None)
    if not new_session or new_session['sessionId'] == old_session['sessionId'] or new_session['revision'] != 0 or new_session['dirty']:
        raise smoke.Failure(f'file was not reopened in a clean independent RHWP session: {new_session!r}')
    a.wait('return document.activeElement?.classList.contains("rhwp-input")===true')
    a.key('ctrl+Home')
    wait_status(a, lambda s: s.get('caret') == '0:0:0', 'reopened first paragraph start')
    a.key(*(['Right'] * (len(ORIGINAL) + len(SAMPLE))))
    reopened = wait_status(a, lambda s: s.get('caret') == f'0:0:{len(ORIGINAL) + len(SAMPLE)}', 'reopened caret at inserted sample end')
    if current_size(a.d) != '24':
        raise smoke.Failure(f'independent reopen model/render lost 24 pt sample: {reopened!r}, {current_size(a.d)!r}')
    row['reopen'] = {'status': 'PASS', 'freshSession': True, 'revision': new_session['revision'], 'dirty': new_session['dirty'],
                     'caret': reopened['caret'], 'effectiveFontSizePt': int(current_size(a.d)),
                     'canvas': a.d.js("const c=document.querySelector('.rhwp-page__canvas');return {width:c?.width,height:c?.height,painted:!!c?.toDataURL('image/png')}")}
    if not row['reopen']['canvas']['painted'] or row['reopen']['canvas']['width'] <= 0 or row['reopen']['canvas']['height'] <= 0:
        raise smoke.Failure(f'reopened RHWP page did not paint: {row["reopen"]["canvas"]!r}')
    a.d.screenshot(args.out / f'{fmt}-reopened.png')
    if not rhwp_poc.close_tab(a.d, path.name):
        raise smoke.Failure(f'clean reopened RHWP requested discard on close: {path.name}')
    row['status'] = 'PASS'
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--driver', required=True)
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--formats', nargs='+', choices=('hwp', 'hwpx'), default=('hwp', 'hwpx'))
    parser.add_argument('--port', type=int, default=4444)
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.fixtures = args.fixtures.resolve()
    args.out.mkdir(parents=True, exist_ok=False)
    (args.out / 'docs').mkdir()
    report = {'status': 'RUNNING', 'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'appSha256': sha(args.app), 'harnessSha256': sha(__file__),
              'inspectorSha256': sha(ROOT / 'scripts/tests/stage1-rhwp-font-typing-inspect.mjs'),
              'wasm': json.loads((ROOT / 'public/rhwp/RELEASE.json').read_text()),
              'environment': {'display': 'Linux X11/Xvfb', 'input': 'trusted xdotool key events',
                              'ime': 'private IBus Hangul', 'syntheticComposition': False}, 'formats': []}
    smoke.APP = str(args.app.resolve())
    smoke.DRIVER_LOG = args.out / 'driver.log'
    d = None
    try:
        with smoke.tauri_driver(args.driver, args.port, str(args.out / 'data')) as start:
            d = start()
            a = base.Acceptance(args, d, report)
            a.wait("return document.querySelector('.document-bar')!==null", timeout=60)
            for fmt in args.formats:
                report['activeFormat'] = fmt
                scenario(a, args, fmt, report)
            d.quit()
            d = None
        report['teardown'] = smoke.TEARDOWN
        report['status'] = 'PASS'
    except Exception as error:
        report.update(status='FAIL', error=str(error), traceback=traceback.format_exc())
        if d:
            try:
                report['failureState'] = {'status': status(d), 'size': current_size(d)}
                d.screenshot(args.out / 'failure.png')
            except Exception as inspection_error:
                report['failureInspectionError'] = str(inspection_error)
            try:
                d.quit()
            except Exception as cleanup_error:
                report['quitError'] = str(cleanup_error)
        report['teardown'] = smoke.TEARDOWN
    finally:
        (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    print(json.dumps({'status': report['status'], 'error': report.get('error')}, ensure_ascii=False))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())

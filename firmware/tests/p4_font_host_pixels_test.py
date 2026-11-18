"""Actual renderer pin policy + production receiver, cJSON and pthreads under ASan/UBSan."""
from pathlib import Path
import pytest
import p4_bubble_pixels_test as receiver_tests
from p4_bubble_pixels_test import desire, transfer, send, select, solid
from p4_render_trace_test import function
ROOT=Path(__file__).resolve().parents[1]

@pytest.fixture(scope="module")
def renderer_receiver(tmp_path_factory):
    source=(ROOT/'main/pet_p4_renderer.c').read_text()
    helpers=r'''
static struct {uint32_t bubble_select_us,pinned_blit_us;} g_render_trace;
static int64_t esp_timer_get_time(void){return 0;}
static uint32_t elapsed_us_clamped(int64_t a,int64_t b){return (uint32_t)(b-a);}
static void pet_p4_render_trace_add(uint32_t*a,uint32_t b){*a+=b;}
static unsigned local_calls;
static uint16_t *g_framebuffer=framebuffer+1;
static const char *draw_text_line_medium_vcenter(const char*s,int x,int y,int h,int w,uint16_t c,bool e){
 (void)s;(void)x;(void)y;(void)h;(void)w;(void)c;(void)e;local_calls++;return "";
}
'''
    helpers+=''.join(function(source,n) for n in ('renderer_bubble_select','renderer_bubble_draw_pinned','draw_card_body_lines'))
    # Reuse the receiver's real cJSON/pthread/ASan harness. Only its main TU is
    # extended; the production receiver is compiled unchanged as a separate TU.
    original=Path.write_text
    def write(path,data,*args,**kwargs):
        if path.name=='main.c' and 'race_writer' in data:
            data=data.replace('pet_bubble_pixels_select(', 'renderer_bubble_select(')
            data=data.replace('pet_bubble_pixels_draw_pinned(', 'renderer_bubble_draw_pinned(')
            data=data.replace('static void *race_writer',helpers+'\nstatic void *race_writer',1)
            data=data.replace('bool ok=renderer_bubble_draw_pinned(&held,','bool aggregate=held.pixels;int title_pin=held.title_pin,body_pin=held.body_pin;bool ok=renderer_bubble_draw_pinned(&held,')
            data=data.replace('assert(ok==cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(v,"ok")));assert(framebuffer',
                'assert(held.pixels==aggregate&&held.title_pin==title_pin&&held.body_pin==body_pin);assert(ok==cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(v,"ok")));assert(framebuffer')
            marker='  if(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(c,"release")))'
            extra=r'''
  v=cJSON_GetObjectItemCaseSensitive(c,"bodyDraw");if(v){
   assert(holding);local_calls=0;
   draw_card_body_lines(held.body,0,0,496,0,&held);
   assert(local_calls==num(v,"localCalls"));
  }
'''
            assert marker in data;data=data.replace(marker,extra+marker)
        return original(path,data,*args,**kwargs)
    with pytest.MonkeyPatch.context() as monkey:
        monkey.setattr(Path,'write_text',write)
        return receiver_tests.receiver.__wrapped__(tmp_path_factory)

def test_title_arrival_alone_keeps_entire_view_local(renderer_receiver):
    renderer_receiver([desire()]+send(transfer('title',style=1))+[
        select(title='title',body='body',pixels=False,hold=True),
        {'drawHeld':{'style':1,'ok':False}},
        {'bodyDraw':{'localCalls':1}},
        {'drawHeld':{'style':4,'ok':False}},
        {'release':True}])

def test_body_arrival_alone_keeps_entire_view_local(renderer_receiver):
    renderer_receiver([desire()]+send(transfer('body'))+[
        select(title='title',body='body',pixels=False,hold=True),
        {'bodyDraw':{'localCalls':1}},
        {'drawHeld':{'style':4,'ok':False}},
        {'drawHeld':{'style':1,'ok':False}}, {'release':True}])

def test_pinned_title_and_body_keep_same_snapshot_after_peer_retirement(renderer_receiver):
    renderer_receiver([desire()]+send(transfer('title',style=1))+send(transfer('body'))+[
        select(title='title',body='body',pixels=True,hold=True),
        desire(client='c'*32),
        {'drawHeld':{'style':1,'ok':True,'first':0}},
        {'bodyDraw':{'localCalls':0}},
        {'drawHeld':{'style':4,'ok':True,'first':0}}, {'release':True},
        select(title='new title',body='new body',pixels=False,hold=True),
        {'drawHeld':{'style':1,'ok':False}}, {'bodyDraw':{'localCalls':1}}, {'release':True}])

def test_caption_page_miss_does_not_flicker_already_pinned_host_title(renderer_receiver):
    renderer_receiver([desire()]+send(transfer('title',style=1))+
        send(transfer('caption',style=2,pages=3))+[
        select(title='title',body='caption',style=2,pixels=True,hold=True),
        {'drawHeld':{'style':1,'ok':True,'first':0}},
        {'drawHeld':{'style':2,'page':1,'pinPage':True,'ok':False}}, {'release':True}]+
        send(transfer('caption',style=2,page=1,pages=3))+[
        select(title='title',body='caption',style=2,pixels=True,hold=True),
        {'drawHeld':{'style':2,'page':1,'pinPage':True,'ok':True,'first':0}},
        {'drawHeld':{'style':1,'ok':True,'first':0}}, {'release':True}])

def test_actual_host_policy_concurrent_retirement(renderer_receiver):
    receiver_tests.test_real_mutex_concurrent_draw_and_peer_retirement_keep_pins_safe(renderer_receiver)

def test_no_resident_coverage_gate_and_caption_title_draws_before_page_selection():
    text=(ROOT/'main/pet_p4_renderer.c').read_text()
    for n in ('draw_bubble','draw_card_body_lines','draw_session_queue_uncached'):
        assert 'renderer_prefers_resident' not in function(text,n)
    bubble=function(text,'draw_bubble')
    assert bubble.index('renderer_bubble_draw_pinned(&text, PET_BUBBLE_TITLE') < bubble.index('pet_bubble_pixels_pin_page(&text,host_page)')
    assert 'if (realtime && host_pages && text.pixels)' in bubble
    assert 'renderer_prefers_resident_text' not in text
    assert 'pet_bubble_pixels_revision()' in function(text,'session_overlay_signature')
    assert 'NULL /* Approval text is local-only' in function(text,'draw_approval_overlay')

def test_session_cache_signature_tracks_pixel_arrival_without_text_change(tmp_path):
    import subprocess
    text=(ROOT/'main/pet_p4_renderer.c').read_text()
    code=r'''
#include <assert.h>
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>
#define PET_P4_SESSION_QUEUE_MAX 4
typedef struct {char id[16],title[16],content[16],state[16];} pet_p4_session_queue_item_t;
typedef struct {unsigned session_queue_count,current_session_index;bool session_voice_active;pet_p4_session_queue_item_t session_queue[4];} pet_p4_runtime_state_t;
static uint32_t revision;
static uint32_t pet_bubble_pixels_revision(void){return revision;}
'''
    code+=''.join(function(text,n) for n in ('session_overlay_visible_window','session_cache_hash_bytes','session_cache_hash_text','session_overlay_signature'))
    code+=r'''
int main(void){
 pet_p4_runtime_state_t state={.session_queue_count=1};
 strcpy(state.session_queue[0].id,"session");strcpy(state.session_queue[0].title,"same title");
 uint64_t old=session_overlay_signature(&state);
 assert(session_overlay_signature(&state)==old);
 revision++;uint64_t arrived=session_overlay_signature(&state);
 assert(arrived!=old&&session_overlay_signature(&state)==arrived);
 revision++;assert(session_overlay_signature(&state)!=arrived);
 return 0;
}
'''
    path=tmp_path/'cache.c';path.write_text(code);binary=tmp_path/'cache'
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',str(path),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True)

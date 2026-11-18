#pragma once

#if PET_P4_SYSTEM_WIFI
#include "pet_p4_protocol.h"
#include "pet_p4_lan_volume.h"
#include "cJSON.h"

typedef enum {
  PET_LAN_CONTROL_COMPONENT = 9,
  PET_LAN_CONTROL_REBOOT = 10,
  PET_LAN_CONTROL_KEYBOARD = 15
} pet_lan_control_op_t;
cJSON *pet_p4_keyboard_config(const cJSON *request, const char *board);

typedef struct {
  char ip[16];
  bool ready;
  bool paired;
  bool busy;
  bool failed;
} pet_lan_pair_view_t;

void pet_p4_lan_start(void);
void pet_p4_lan_usb_active(void);
bool pet_p4_lan_realtime_press(const pet_p4_runtime_state_t *state, uint64_t pressed_ms, uint64_t now_ms);
void pet_p4_lan_process(pet_p4_runtime_state_t *state, uint64_t now_ms);
void pet_p4_lan_pair_view(pet_lan_pair_view_t *view);
void pet_p4_lan_forget(void);
bool pet_p4_lan_trust_wired(pet_p4_send_line_fn send, void *route);
cJSON *pet_p4_lan_trust_usb(const cJSON *payload, pet_p4_send_line_fn send, void *route);
bool pet_p4_lan_schedule_control(uint32_t token);
void pet_p4_lan_control_run(pet_p4_runtime_state_t *state, uint32_t token, bool admitted);
bool pet_p4_lan_volume_claim(uint8_t *volume);
void pet_p4_lan_volume_finish(bool applied);

/* Shared protocol hooks run under the state lock. A non-null empty speech
 * object retires the transient LAN speech. */
void pet_p4_lan_apply(pet_p4_runtime_state_t *state, const char *source,
                      const cJSON *status, const cJSON *speech, const cJSON *sessions);
void pet_p4_lan_expire(pet_p4_runtime_state_t *state);
#endif

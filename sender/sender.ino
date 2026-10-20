// ESP32-C3 SuperMini + WCMCU-230. Boot: normal demo at one frame/second.
// CAN LAB commands provide bounded, explicitly started load tests over USB.
#include "driver/twai.h"
#include "esp_err.h"
#include "../firmware/load_control.h"

constexpr gpio_num_t CAN_TX_PIN = GPIO_NUM_5;
constexpr gpio_num_t CAN_RX_PIN = GPIO_NUM_4;
constexpr uint32_t CAN_ID = 0x123;
constexpr int LED_PIN = 8; // SuperMini onboard LED: active low.
uint32_t ledUntil = 0;
bool ledActive = false;
canlab::Pacer pacer;
bool running = false, demo = true;
uint32_t testId = 0, targetRate = 1, started = 0, durationMs = 0;
uint32_t counter = 0, queued = 0, rejected = 0, skipped = 0, cancelled = 0;
uint32_t lastReport = 0, reportQueued = 0, lastDemo = 0;
uint32_t failedBase = 0, errorsBase = 0;
char input[80]; unsigned inputLength = 0; bool overflow = false;

void hello() { Serial.println("LAB HELLO role=sender version=1 bitrate=500000 demo=1 max_rate=20000 max_seconds=60"); }

void stats() {
  twai_status_info_t s = {};
  if (twai_get_status_info(&s) != ESP_OK) return;
  uint32_t now = millis(), span = now - lastReport;
  // Keep observation time advancing after STOP so measured zero-rate windows reach the chart.
  uint32_t elapsed = testId ? now - started : 0;
  uint32_t fps = span ? (uint32_t)((uint64_t)(queued - reportQueued) * 1000 / span) : 0;
  Serial.printf("LAB STATS role=sender test=%lu running=%d target=%lu queued=%lu queued_fps=%lu rejected=%lu skipped=%lu cancelled=%lu pending=%lu failed=%lu errors=%lu tec=%lu rec=%lu state=%d elapsed_ms=%lu\n",
    (unsigned long)testId, running, (unsigned long)targetRate, (unsigned long)queued,
    (unsigned long)fps, (unsigned long)rejected, (unsigned long)skipped, (unsigned long)cancelled,
    (unsigned long)s.msgs_to_tx, (unsigned long)(s.tx_failed_count - failedBase),
    (unsigned long)(s.bus_error_count - errorsBase), (unsigned long)s.tx_error_counter,
    (unsigned long)s.rx_error_counter, (int)s.state, (unsigned long)elapsed);
  lastReport = now; reportQueued = queued;
}

void stopLoad(const char* reason) {
  demo = false;
  if (running) {
    running = false;
    twai_status_info_t s = {};
    if (twai_get_status_info(&s) == ESP_OK) {
      // Queue clearing discards waiting frames; an in-flight frame may still finish.
      cancelled += s.msgs_to_tx;
      twai_clear_transmit_queue();
    }
    stats();
    Serial.printf("LAB END role=sender test=%lu reason=%s\n", (unsigned long)testId, reason);
  }
}

void command(const char* line) {
  auto c = canlab::parse(line);
  switch (c.kind) {
    case canlab::Kind::Hello: hello(); break;
    case canlab::Kind::Status: stats(); break;
    case canlab::Kind::Stop:
      stopLoad("stop");
      Serial.printf("LAB ACK role=sender command=stop test=%lu\n", (unsigned long)testId);
      break;
    case canlab::Kind::Demo: {
      // Reconnecting may resume the low-rate demo, but must never replace a load test.
      twai_status_info_t s = {};
      if (running || twai_get_status_info(&s) != ESP_OK || s.state != TWAI_STATE_RUNNING) {
        Serial.println("LAB ERROR role=sender reason=not_ready"); break;
      }
      twai_clear_transmit_queue();
      demo = true; testId = 0; targetRate = 1; lastDemo = millis();
      Serial.println("LAB ACK role=sender command=demo test=0");
      stats(); break;
    }
    case canlab::Kind::Start: {
      twai_status_info_t s = {};
      if (running || twai_get_status_info(&s) != ESP_OK || s.state != TWAI_STATE_RUNNING || s.msgs_to_tx) {
        Serial.println("LAB ERROR role=sender reason=not_ready"); break;
      }
      demo = false; running = true; testId = c.test; targetRate = c.rate;
      durationMs = c.seconds * 1000; started = lastReport = millis();
      counter = queued = rejected = skipped = cancelled = reportQueued = 0;
      failedBase = s.tx_failed_count; errorsBase = s.bus_error_count;
      pacer.reset(micros(), targetRate);
      Serial.printf("LAB ACK role=sender command=start test=%lu rate=%lu duration_ms=%lu\n", (unsigned long)testId, (unsigned long)targetRate, (unsigned long)durationMs);
      stats(); break;
    }
    case canlab::Kind::Rate:
      if (!running || c.test != testId) { Serial.println("LAB ERROR role=sender reason=no_active_test"); break; }
      targetRate = c.rate; pacer.reset(micros(), targetRate);
      Serial.printf("LAB ACK role=sender command=rate test=%lu rate=%lu\n", (unsigned long)testId, (unsigned long)targetRate);
      break;
    case canlab::Kind::Unknown: break;
    default: Serial.println("LAB ERROR role=sender reason=invalid_command");
  }
}

void serialCommands() {
  for (unsigned read = 0; Serial.available() && read < 160; read++) {
    char ch = (char)Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') {
      if (!overflow) { input[inputLength] = 0; command(input); }
      else Serial.println("LAB ERROR role=sender reason=command_too_long");
      inputLength = 0; overflow = false;
    } else if (inputLength < sizeof(input) - 1 && !overflow) input[inputLength++] = ch;
    else overflow = true;
  }
}

void setup() {
  Serial.begin(115200); pinMode(LED_PIN, OUTPUT); digitalWrite(LED_PIN, HIGH); delay(1500);
  twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, TWAI_MODE_NORMAL);
  g.tx_queue_len = 32;
  g.alerts_enabled = TWAI_ALERT_TX_SUCCESS | TWAI_ALERT_BUS_ERROR | TWAI_ALERT_BUS_OFF;
  twai_timing_config_t t = TWAI_TIMING_CONFIG_500KBITS();
  twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL();
  if (twai_driver_install(&g, &t, &f) != ESP_OK || twai_start() != ESP_OK) {
    Serial.println("TWAI start failed"); while (true) delay(1000);
  }
  Serial.println("Sender ready"); hello(); lastReport = lastDemo = millis();
}

void loop() {
  serialCommands();
  uint32_t now = millis();
  twai_status_info_t s = {};
  if (twai_get_status_info(&s) != ESP_OK) { stopLoad("driver_error"); delay(1); return; }
  if (s.state == TWAI_STATE_BUS_OFF) {
    stopLoad("bus_off");
    Serial.println("Bus-Off -> Recovery"); twai_initiate_recovery();
  } else if (s.state == TWAI_STATE_STOPPED) {
    twai_start(); // Recovery never automatically resumes a load test.
  } else if (s.state == TWAI_STATE_RUNNING) {
    if (running && (uint32_t)(now - started) >= durationMs) stopLoad("timeout");
    if (running) {
      auto due = pacer.take(micros()); skipped += due.skipped;
      for (uint32_t i = 0; i < due.count; i++) {
        twai_message_t msg = {}; msg.identifier = CAN_ID; msg.data_length_code = 8;
        memcpy(msg.data, &counter, 4); memcpy(msg.data + 4, &testId, 4);
        if (twai_transmit(&msg, 0) == ESP_OK) { queued++; counter++; }
        else rejected++; // Rejected offers do not introduce artificial payload gaps.
      }
    } else if (demo && (uint32_t)(now - lastDemo) >= 1000) {
      lastDemo = now;
      twai_message_t msg = {}; msg.identifier = CAN_ID; msg.data_length_code = 4;
      memcpy(msg.data, &counter, 4);
      esp_err_t result = twai_transmit(&msg, 0);
      Serial.printf("TX #%lu -> %s\n", (unsigned long)counter, result == ESP_OK ? "ok" : "ERROR (peer/wiring?)");
      if (result == ESP_OK) counter++;
    }
  }
  uint32_t alerts = 0;
  if (twai_read_alerts(&alerts, 0) == ESP_OK) {
    // ACK-confirmed transmissions only. Coalesce rapid successes; never delay CAN for an LED.
    if ((alerts & TWAI_ALERT_TX_SUCCESS) && !(alerts & TWAI_ALERT_BUS_OFF)) {
      digitalWrite(LED_PIN, LOW); ledUntil = millis() + 20; ledActive = true;
    }
    if (alerts & TWAI_ALERT_BUS_OFF) { digitalWrite(LED_PIN, HIGH); ledActive = false; }
    if (!running && demo && alerts) {
      Serial.printf("DIAG TX_ACK=%d BUS_ERROR=%d\n", !!(alerts & TWAI_ALERT_TX_SUCCESS), !!(alerts & TWAI_ALERT_BUS_ERROR));
    }
  }
  if (ledActive && (int32_t)(millis() - ledUntil) >= 0) {
    digitalWrite(LED_PIN, HIGH); ledActive = false;
  }
  if ((uint32_t)(millis() - lastReport) >= 1000) stats();
  delay(1);
}

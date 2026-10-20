// ESP32-C3 SuperMini + WCMCU-230. Drain CAN without per-frame LED delays.
#include "driver/twai.h"
#include "esp_err.h"
#include "../firmware/load_control.h"
constexpr gpio_num_t CAN_TX_PIN = GPIO_NUM_5;
constexpr gpio_num_t CAN_RX_PIN = GPIO_NUM_4;
constexpr int LED_PIN = 8;
uint32_t testId = 0, started = 0, lastReport = 0, reportRx = 0;
uint32_t received = 0, gaps = 0, duplicates = 0, previous = 0, lastCounter = 0;
uint32_t missedBase = 0, overrunBase = 0, errorsBase = 0, ledUntil = 0, lastWait = 0;
bool havePrevious = false;
char input[80]; unsigned inputLength = 0; bool overflow = false;

void hello() { Serial.println("LAB HELLO role=receiver version=1 bitrate=500000 max_rate=20000 max_seconds=60"); }
void stats() {
  twai_status_info_t s = {};
  if (twai_get_status_info(&s) != ESP_OK) return;
  uint32_t now = millis(), span = now - lastReport;
  uint32_t fps = span ? (uint32_t)((uint64_t)(received - reportRx) * 1000 / span) : 0;
  Serial.printf("LAB STATS role=receiver test=%lu rx=%lu rx_fps=%lu counter=%lu gaps=%lu duplicates=%lu missed=%lu overrun=%lu errors=%lu tec=%lu rec=%lu state=%d elapsed_ms=%lu\n",
    (unsigned long)testId, (unsigned long)received, (unsigned long)fps,
    (unsigned long)lastCounter, (unsigned long)gaps, (unsigned long)duplicates,
    (unsigned long)(s.rx_missed_count - missedBase), (unsigned long)(s.rx_overrun_count - overrunBase),
    (unsigned long)(s.bus_error_count - errorsBase), (unsigned long)s.tx_error_counter,
    (unsigned long)s.rx_error_counter, (int)s.state, (unsigned long)(testId ? now - started : 0));
  lastReport = now; reportRx = received;
}
void command(const char* line) {
  auto c = canlab::parse(line);
  switch (c.kind) {
    case canlab::Kind::Hello: hello(); break;
    case canlab::Kind::Status: stats(); break;
    case canlab::Kind::Arm: {
      twai_status_info_t s = {};
      if (twai_get_status_info(&s) != ESP_OK || s.state != TWAI_STATE_RUNNING) { Serial.println("LAB ERROR role=receiver reason=not_ready"); break; }
      twai_clear_receive_queue();
      testId = c.test; received = gaps = duplicates = reportRx = lastCounter = 0;
      havePrevious = false; started = lastReport = millis();
      missedBase = s.rx_missed_count; overrunBase = s.rx_overrun_count; errorsBase = s.bus_error_count;
      Serial.printf("LAB ACK role=receiver command=arm test=%lu\n", (unsigned long)testId); stats(); break;
    }
    case canlab::Kind::Stop:
      Serial.printf("LAB ACK role=receiver command=stop test=%lu\n", (unsigned long)testId); break;
    case canlab::Kind::Unknown: break;
    default: Serial.println("LAB ERROR role=receiver reason=invalid_command");
  }
}
void serialCommands() {
  for (unsigned read = 0; Serial.available() && read < 160; read++) {
    char ch = (char)Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') {
      if (!overflow) { input[inputLength] = 0; command(input); }
      else Serial.println("LAB ERROR role=receiver reason=command_too_long");
      inputLength = 0; overflow = false;
    } else if (inputLength < sizeof(input) - 1 && !overflow) input[inputLength++] = ch;
    else overflow = true;
  }
}
void setup() {
  Serial.begin(115200); pinMode(LED_PIN, OUTPUT); digitalWrite(LED_PIN, HIGH); delay(1500);
  twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, TWAI_MODE_NORMAL);
  g.rx_queue_len = 128;
  twai_timing_config_t t = TWAI_TIMING_CONFIG_500KBITS();
  twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL();
  if (twai_driver_install(&g, &t, &f) != ESP_OK || twai_start() != ESP_OK) {
    Serial.println("TWAI-Start fehlgeschlagen"); while (true) delay(1000);
  }
  Serial.println("Empfaenger bereit"); hello(); lastReport = lastWait = millis();
}
void loop() {
  serialCommands();
  bool activity = false;
  for (unsigned i = 0; i < 128; i++) {
    twai_message_t msg = {};
    if (twai_receive(&msg, 0) != ESP_OK) break;
    activity = true; ledUntil = millis() + 20; digitalWrite(LED_PIN, LOW);
    if (!msg.rtr && !msg.extd && msg.identifier == 0x123 && msg.data_length_code == 8) {
      uint32_t id, count; memcpy(&count, msg.data, 4); memcpy(&id, msg.data + 4, 4);
      if (testId && id == testId) {
        if (havePrevious) {
          uint32_t difference = count - previous;
          if (!difference) duplicates++;
          else if (difference < 0x80000000UL) gaps += difference - 1;
        } else gaps += count; // Missing initial sequence values are also visible.
        previous = lastCounter = count; havePrevious = true; received++;
      }
      // Test frames are never printed individually, including unknown test IDs.
    } else {
      Serial.printf("RX ID 0x%03lX DLC %d Daten:", (unsigned long)msg.identifier, msg.data_length_code);
      if (!msg.rtr) for (int j = 0; j < msg.data_length_code && j < 8; j++) Serial.printf(" %02X", msg.data[j]);
      if (!msg.rtr && !msg.extd && msg.identifier == 0x123 && msg.data_length_code == 4) {
        uint32_t count; memcpy(&count, msg.data, 4); Serial.printf("  (Zaehler=%lu)", (unsigned long)count);
      }
      Serial.println();
    }
  }
  uint32_t now = millis();
  if (activity) lastWait = now;
  if (ledUntil && (int32_t)(now - ledUntil) >= 0) { digitalWrite(LED_PIN, HIGH); ledUntil = 0; }
  if ((uint32_t)(now - lastReport) >= 1000) stats();
  if (!testId && (uint32_t)(now - lastWait) >= 1000) { Serial.println("... warte auf Frames"); lastWait = now; }
  delay(1);
}

// Controlled bench diagnostics. Boots with TWAI disabled; no automatic traffic.
// Serial commands: quiet, self500, self125, internal, levels, pulses, holdlow,
// normal500, normal125, send, status. Static stimuli: isolated bench only.
#include <Arduino.h>
#include "driver/twai.h"
#include "esp_err.h"
#include "driver/gpio.h"
#include "esp_rom_gpio.h"
#include "soc/gpio_sig_map.h"

constexpr gpio_num_t TX_PIN = GPIO_NUM_5;
constexpr gpio_num_t RX_PIN = GPIO_NUM_4;
bool installed = false;
bool listening = false;
uint32_t sequence = 0;
uint32_t lowUntil = 0;

void quiet() {
  lowUntil = 0;
  if (installed) {
    twai_status_info_t state = {};
    if (twai_get_status_info(&state) == ESP_OK && state.state == TWAI_STATE_RUNNING) twai_stop();
    esp_err_t result = twai_driver_uninstall();
    Serial.printf("PROBE UNINSTALL %s\n", esp_err_to_name(result));
    if (result != ESP_OK) return;
    installed = false;
  }
  listening = false;
  // Keep the transceiver recessive while the controller is detached.
  pinMode((int)TX_PIN, OUTPUT);
  digitalWrite((int)TX_PIN, HIGH);
}

bool start(twai_mode_t mode, bool slow) {
  quiet();
  if (installed) return false;
  twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT(TX_PIN, RX_PIN, mode);
  g.alerts_enabled = TWAI_ALERT_TX_SUCCESS | TWAI_ALERT_TX_FAILED | TWAI_ALERT_BUS_ERROR | TWAI_ALERT_BUS_OFF;
  twai_timing_config_t timing = slow ? (twai_timing_config_t)TWAI_TIMING_CONFIG_125KBITS() : (twai_timing_config_t)TWAI_TIMING_CONFIG_500KBITS();
  twai_filter_config_t filter = TWAI_FILTER_CONFIG_ACCEPT_ALL();
  esp_err_t result = twai_driver_install(&g, &timing, &filter);
  Serial.printf("PROBE INSTALL bitrate=%d mode=%d %s\n", slow ? 125000 : 500000, (int)mode, esp_err_to_name(result));
  if (result != ESP_OK) return false;
  installed = true;
  result = twai_start();
  Serial.printf("PROBE START %s\n", esp_err_to_name(result));
  return result == ESP_OK;
}

void status() {
  twai_status_info_t state = {};
  if (installed && twai_get_status_info(&state) == ESP_OK) {
    Serial.printf("PROBE STATUS state=%d TEC=%lu REC=%lu bus_errors=%lu rx_missed=%lu\n", (int)state.state,
      (unsigned long)state.tx_error_counter, (unsigned long)state.rx_error_counter,
      (unsigned long)state.bus_error_count, (unsigned long)state.rx_missed_count);
  } else Serial.println("PROBE STATUS quiet");
}

void selfTest(bool slow, bool internal = false) {
  unsigned passed = 0;
  for (unsigned trial = 0; trial < 5; trial++) {
    if (!start(TWAI_MODE_NO_ACK, slow)) break;
    if (internal) {
      // Control test: read back the driven TX pad into TWAI via GPIO matrix.
      // Bypasses the transceiver and GPIO4; never proves external CAN delivery.
      gpio_set_direction(TX_PIN, GPIO_MODE_INPUT_OUTPUT);
      // gpio_set_direction resets the output matrix to GPIO output in IDF 4.4.
      esp_rom_gpio_connect_out_signal((uint32_t)TX_PIN, TWAI_TX_IDX, false, false);
      esp_rom_gpio_connect_in_signal((uint32_t)TX_PIN, TWAI_RX_IDX, false);
    }
    twai_message_t tx = {};
    tx.identifier = 0x321;
    tx.data_length_code = 4;
    tx.data[0] = 0xA5; tx.data[1] = 0x5A; tx.data[2] = trial; tx.data[3] = 0xC3;
    tx.self = 1;
    tx.ss = 1;
    esp_err_t result = twai_transmit(&tx, pdMS_TO_TICKS(100));
    twai_message_t rx = {};
    esp_err_t received = result == ESP_OK ? twai_receive(&rx, pdMS_TO_TICKS(400)) : result;
    bool match = received == ESP_OK && rx.identifier == tx.identifier && rx.data_length_code == 4 && !rx.rtr && !rx.extd && memcmp(rx.data, tx.data, 4) == 0;
    if (match) passed++;
    Serial.printf("PROBE %s trial=%u bitrate=%d enqueue=%s receive=%s match=%d\n", internal ? "INTERNAL" : "SELF", trial, slow ? 125000 : 500000,
      esp_err_to_name(result), esp_err_to_name(received), match);
    status();
    quiet();
    delay(100);
  }
  Serial.printf("PROBE %s DONE bitrate=%d passed=%u/5 (local feedback, not network delivery)\n", internal ? "INTERNAL" : "SELF", slow ? 125000 : 500000, passed);
}

void setup() {
  quiet();
  Serial.begin(115200);
  Serial.setTimeout(100);
  delay(1500);
  Serial.printf("PROBE READY chip=%012llX TX=5 RX=4 default=quiet\n", ESP.getEfuseMac());
}

void levelTest() {
  quiet();
  pinMode((int)RX_PIN, INPUT_PULLUP);
  unsigned passed = 0;
  for (unsigned trial = 0; trial < 5; trial++) {
    digitalWrite((int)TX_PIN, HIGH);
    delay(5);
    int high = digitalRead((int)RX_PIN);
    digitalWrite((int)TX_PIN, LOW);
    delay(5);
    int low = digitalRead((int)RX_PIN);
    digitalWrite((int)TX_PIN, HIGH);
    if (high == HIGH && low == LOW) passed++;
    Serial.printf("PROBE LEVEL trial=%u TX_HIGH_RX=%d TX_LOW_RX=%d\n", trial, high, low);
    delay(10);
  }
  Serial.printf("PROBE LEVEL DONE passed=%u/5 (static pad feedback, not CAN delivery)\n", passed);
}

void pulseTest() {
  quiet();
  if (installed) return;
  pinMode((int)RX_PIN, INPUT_PULLUP);
  const uint32_t sampleAt[] = {10, 100, 300, 500, 1000, 2000, 5000, 10000};
  for (unsigned trial = 0; trial < 5; trial++) {
    digitalWrite((int)TX_PIN, HIGH);
    delay(5);
    int before = digitalRead((int)RX_PIN);
    int samples[8];
    uint32_t elapsed[8];
    digitalWrite((int)TX_PIN, LOW);
    uint32_t began = micros();
    for (unsigned i = 0; i < 8; i++) {
      while ((uint32_t)(micros() - began) < sampleAt[i]) {}
      samples[i] = digitalRead((int)RX_PIN);
      elapsed[i] = (uint32_t)(micros() - began);
    }
    digitalWrite((int)TX_PIN, HIGH);
    delay(5);
    int after = digitalRead((int)RX_PIN);
    Serial.printf("PROBE PULSE trial=%u RX_BEFORE=%d", trial, before);
    for (unsigned i = 0; i < 8; i++) {
      Serial.printf(" RX_AT_%luus=%d", (unsigned long)elapsed[i], samples[i]);
    }
    Serial.printf(" RX_AFTER=%d\n", after);
  }
  quiet();
  Serial.println("PROBE PULSE DONE (GPIO samples, not an oscilloscope measurement)");
}

void loop() {
  // Bounded static bench stimulus for multimeter measurements on an isolated bus.
  if (lowUntil && (int32_t)(millis() - lowUntil) >= 0) {
    quiet();
    Serial.println("PROBE HOLD expired; TX high");
  }
  if (Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();
    Serial.printf("PROBE COMMAND %s\n", command.c_str());
    if (command == "quiet") { quiet(); Serial.println("PROBE QUIET"); }
    else if (command == "self500") selfTest(false);
    else if (command == "self125") selfTest(true);
    else if (command == "internal") selfTest(false, true);
    else if (command == "levels") levelTest();
    else if (command == "pulses") pulseTest();
    else if (command == "holdlow") {
      quiet();
      if (!installed) {
        digitalWrite((int)TX_PIN, LOW);
        lowUntil = millis() + 60000;
        Serial.println("PROBE HOLD TX low for 60 seconds; isolated bench only");
      }
    }
    else if (command == "normal500" || command == "normal125") {
      listening = start(TWAI_MODE_NORMAL, command == "normal125");
      Serial.println(listening ? "PROBE NORMAL READY" : "PROBE NORMAL FAILED");
    } else if (command == "status") status();
    else if (command == "send" && listening) {
      twai_message_t msg = {};
      msg.identifier = 0x123; msg.data_length_code = 4; msg.ss = 1;
      memcpy(msg.data, &sequence, 4);
      uint32_t stale;
      twai_read_alerts(&stale, 0);
      esp_err_t result = twai_transmit(&msg, pdMS_TO_TICKS(100));
      uint32_t alerts = 0;
      // Accumulate alerts up to completion; BUS_ERROR can precede TX_FAILED.
      uint32_t deadline = millis() + 400;
      while (result == ESP_OK && !(alerts & (TWAI_ALERT_TX_SUCCESS | TWAI_ALERT_TX_FAILED)) && (int32_t)(deadline - millis()) > 0) {
        uint32_t next = 0;
        if (twai_read_alerts(&next, pdMS_TO_TICKS(20)) == ESP_OK) alerts |= next;
      }
      Serial.printf("PROBE SEND seq=%lu enqueue=%s ack=%d failed=%d alerts=0x%lX\n", (unsigned long)sequence++, esp_err_to_name(result),
        !!(alerts & TWAI_ALERT_TX_SUCCESS), !!(alerts & TWAI_ALERT_TX_FAILED), (unsigned long)alerts);
      status();
    }
  }
  if (listening) {
    twai_message_t msg = {};
    if (twai_receive(&msg, 0) == ESP_OK) {
      Serial.printf("RX ID 0x%03lX DLC %d Daten:", (unsigned long)msg.identifier, msg.data_length_code);
      if (!msg.rtr) for (unsigned i = 0; i < msg.data_length_code && i < 8; i++) Serial.printf(" %02X", msg.data[i]);
      Serial.println();
    }
  }
  delay(1);
}

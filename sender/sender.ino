// CAN-Bus Demo: SENDER (ESP32-C3 SuperMini + WCMCU-230 / SN65HVD230)
// Sendet jede Sekunde einen Frame (ID 0x123) mit einem Zaehler.
#include "driver/twai.h"

constexpr gpio_num_t CAN_TX_PIN = GPIO_NUM_5;  // -> CTX am WCMCU-230
constexpr gpio_num_t CAN_RX_PIN = GPIO_NUM_4;  // -> CRX am WCMCU-230
constexpr uint32_t   CAN_ID     = 0x123;

uint32_t counter = 0;

void setup() {
  Serial.begin(115200);
  delay(1500);  // Zeit fuer USB-CDC, damit die ersten Logs sichtbar sind

  // Normal-Modus, 500 kbit/s, alle Frames akzeptieren
  twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, TWAI_MODE_NORMAL);
  twai_timing_config_t  t = TWAI_TIMING_CONFIG_500KBITS();
  twai_filter_config_t  f = TWAI_FILTER_CONFIG_ACCEPT_ALL();

  if (twai_driver_install(&g, &t, &f) != ESP_OK) { Serial.println("Treiber-Install fehlgeschlagen"); while (true) delay(1000); }
  if (twai_start() != ESP_OK)                    { Serial.println("TWAI-Start fehlgeschlagen");     while (true) delay(1000); }
  Serial.println("Sender bereit");
}

void loop() {
  // Bus-Off (z. B. keine Gegenstelle) automatisch wieder aufnehmen
  twai_status_info_t s;
  twai_get_status_info(&s);
  if (s.state == TWAI_STATE_BUS_OFF) {
    Serial.println("Bus-Off -> Recovery");
    twai_initiate_recovery();
    delay(500);
    return;
  }

  twai_message_t msg = {};
  msg.identifier       = CAN_ID;
  msg.data_length_code = 4;
  memcpy(msg.data, &counter, 4);  // Zaehler als 4 Byte (little endian)

  // Senden klappt nur, wenn mind. ein anderer Knoten per ACK bestaetigt
  esp_err_t r = twai_transmit(&msg, pdMS_TO_TICKS(100));
  Serial.printf("TX #%lu -> %s\n", (unsigned long)counter, r == ESP_OK ? "ok" : "FEHLER (Gegenstelle/Verkabelung?)");
  counter++;
  delay(1000);
}

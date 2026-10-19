// CAN-Bus Demo: EMPFAENGER (ESP32-C3 SuperMini + WCMCU-230 / SN65HVD230)
// Gibt jeden empfangenen Frame seriell aus und blinkt die Onboard-LED.
#include "driver/twai.h"

constexpr gpio_num_t CAN_TX_PIN = GPIO_NUM_5;  // -> CTX am WCMCU-230
constexpr gpio_num_t CAN_RX_PIN = GPIO_NUM_4;  // -> CRX am WCMCU-230
constexpr int        LED_PIN    = 8;           // Onboard-LED, active-low

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH);  // LED aus
  delay(1500);

  twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, TWAI_MODE_NORMAL);
  twai_timing_config_t  t = TWAI_TIMING_CONFIG_500KBITS();  // muss zum Sender passen!
  twai_filter_config_t  f = TWAI_FILTER_CONFIG_ACCEPT_ALL();

  if (twai_driver_install(&g, &t, &f) != ESP_OK) { Serial.println("Treiber-Install fehlgeschlagen"); while (true) delay(1000); }
  if (twai_start() != ESP_OK)                    { Serial.println("TWAI-Start fehlgeschlagen");     while (true) delay(1000); }
  Serial.println("Empfaenger bereit");
}

void loop() {
  twai_message_t msg;
  if (twai_receive(&msg, pdMS_TO_TICKS(1000)) == ESP_OK) {
    Serial.printf("RX ID 0x%03lX DLC %d Daten:", (unsigned long)msg.identifier, msg.data_length_code);
    for (int i = 0; i < msg.data_length_code; i++) Serial.printf(" %02X", msg.data[i]);
    if (msg.identifier == 0x123 && msg.data_length_code == 4) {
      uint32_t c;
      memcpy(&c, msg.data, 4);
      Serial.printf("  (Zaehler=%lu)", (unsigned long)c);
    }
    Serial.println();
    digitalWrite(LED_PIN, LOW);  delay(50);  digitalWrite(LED_PIN, HIGH);
  } else {
    Serial.println("... warte auf Frames");
  }
}

#pragma once
#include <stdint.h>
#include <string.h>

namespace canlab {
constexpr uint32_t MAX_RATE = 20000;
constexpr uint32_t MAX_SECONDS = 60;
enum class Kind { Unknown, Invalid, Hello, Status, Stop, Demo, Arm, Start, Rate };
struct Command {
  Kind kind; uint32_t test = 0, rate = 0, seconds = 0;
  explicit Command(Kind value) : kind(value) {}
};

inline bool number(const char* text, uint32_t low, uint32_t high, uint32_t& out) {
  if (!text || !*text) return false;
  uint64_t value = 0;
  for (; *text; text++) {
    if (*text < '0' || *text > '9') return false;
    value = value * 10 + (*text - '0');
    if (value > high) return false;
  }
  if (value < low) return false;
  out = (uint32_t)value;
  return true;
}

inline Command parse(const char* text) {
  Command cmd{Kind::Unknown};
  if (strncmp(text, "LAB ", 4) != 0) return cmd;
  cmd.kind = Kind::Invalid;
  if (strlen(text) >= 80) return cmd;
  char copy[80]; strcpy(copy, text);
  char* tokens[7]; unsigned count = 0; char* state = nullptr;
  for (char* token = strtok_r(copy, " \r", &state); token; token = strtok_r(nullptr, " \r", &state)) {
    if (count == 7) return cmd;
    tokens[count++] = token;
  }
  if (count < 2) return cmd;
  if (count == 2) {
    if (!strcmp(tokens[1], "HELLO")) cmd.kind = Kind::Hello;
    if (!strcmp(tokens[1], "STATUS")) cmd.kind = Kind::Status;
    if (!strcmp(tokens[1], "STOP")) cmd.kind = Kind::Stop;
    if (!strcmp(tokens[1], "DEMO")) cmd.kind = Kind::Demo;
  }
  if (count == 3 && !strcmp(tokens[1], "ARM") && number(tokens[2], 1, UINT32_MAX, cmd.test)) cmd.kind = Kind::Arm;
  if (count == 4 && !strcmp(tokens[1], "RATE") && number(tokens[2], 1, UINT32_MAX, cmd.test) && number(tokens[3], 1, MAX_RATE, cmd.rate)) cmd.kind = Kind::Rate;
  if (count == 5 && !strcmp(tokens[1], "START") && number(tokens[2], 1, UINT32_MAX, cmd.test) && number(tokens[3], 1, MAX_RATE, cmd.rate) && number(tokens[4], 1, MAX_SECONDS, cmd.seconds)) cmd.kind = Kind::Start;
  return cmd;
}

struct Due { uint32_t count, skipped; };
class Pacer {
  uint32_t last = 0, rate = 1;
  uint64_t credit = 0;
public:
  void reset(uint32_t now, uint32_t framesPerSecond) { last = now; rate = framesPerSecond; credit = 0; }
  Due take(uint32_t now) {
    credit += (uint64_t)(uint32_t)(now - last) * rate;
    last = now;
    uint64_t due = credit / 1000000;
    credit %= 1000000;
    // Bound bursts after scheduler stalls; never replay an unbounded backlog.
    return {(uint32_t)(due > 32 ? 32 : due), (uint32_t)(due > 32 ? due - 32 : 0)};
  }
};
}

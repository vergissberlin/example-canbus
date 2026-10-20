#include "../firmware/load_control.h"
#include <assert.h>
#include <stdio.h>
#include <initializer_list>
using namespace canlab;
int main() {
  auto cmd = parse("LAB START 123 20000 60");
  assert(cmd.kind == Kind::Start && cmd.test == 123 && cmd.rate == 20000 && cmd.seconds == 60);
  assert(parse("LAB DEMO").kind == Kind::Demo);
  assert(parse("LAB DEMO 100").kind == Kind::Invalid);
  assert(parse("LAB ARM 4294967295").kind == Kind::Arm);
  assert(parse("LAB RATE 123 1").kind == Kind::Rate);
  for (const char* bad : {"LAB START 0 1 10", "LAB START 1 0 10", "LAB START 1 20001 10", "LAB START 1 1 61", "LAB START 1 1 0", "LAB START 1 -1 10", "LAB START 1 1e3 10", "LAB START 4294967296 1 10", "LAB START 1 1 10 extra", "LAB STOP extra", "LAB RATE 1 9999999999999999999999999"}) assert(parse(bad).kind == Kind::Invalid);
  assert(parse("quiet").kind == Kind::Unknown);
  RecoveryDemo recovery;
  assert(!recovery.recovered(true)); // A stopped sender must not spontaneously restart.
  recovery.interrupted(true);
  assert(!recovery.recovered(false)); // Failed controller restart must not start sending.
  recovery.interrupted(false); // Repeated BUS_OFF observations preserve the intent.
  assert(recovery.recovered(true));
  assert(!recovery.recovered(true)); // Resume only once.
  recovery.interrupted(true); recovery.cancel();
  assert(!recovery.recovered(true)); // An explicit STOP during recovery wins.
  Pacer p; p.reset(0, 3);
  assert(p.take(333333).count == 0);
  assert(p.take(333334).count == 1);
  assert(p.take(1000000).count == 2);
  p.reset(UINT32_MAX - 499, 1000);
  assert(p.take(500).count == 1);
  p.reset(0, 20000);
  auto burst = p.take(1000000);
  assert(burst.count == 32 && burst.skipped == 19968);
  assert(p.take(1000000).count == 0);
  p.reset(0, 1); assert(p.take(999999).count == 0); assert(p.take(1000000).count == 1);
  puts("CAN LAB command bounds, fractional pacing, wraparound and bounded backlog: PASS");
}

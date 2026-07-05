#include <cstdlib>

int clamp_add(int a, int b, int limit) {
  int sum = a + b;
  if (sum > limit) return limit;
  return sum;
}

// untested: never called from main(), so its mutants must SURVIVE
int clamp_sub(int a, int b) {
  int d = a - b;
  if (d < 0) return 0;
  return d;
}

int main() {
  if (clamp_add(1, 2, 10) != 3) return 1;
  if (clamp_add(6, 6, 10) != 10) return 1;
  return 0;
}

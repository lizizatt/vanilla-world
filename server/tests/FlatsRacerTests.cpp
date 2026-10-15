#include "../src/game/Objects/FlatsRacer.h"

#include <cassert>
#include <limits>

int main()
{
    using namespace FlatsRacer;
    float const nan = std::numeric_limits<float>::quiet_NaN();
    float const inf = std::numeric_limits<float>::infinity();
    static_assert(!DefaultEnabled, "The custom movement grant must be opt-in.");
    static_assert(MountDisplayId == 10318, "Use the verified GoblinRocketCar display.");
    assert(!Authorized(DefaultEnabled, "127.0.0.1"));
    assert(Authorized(true, "127.0.0.1"));
    assert(Authorized(true, "::1"));
    assert(Authorized(true, "::ffff:127.0.0.1"));
    for (auto address : {"", "localhost", "127.0.0.1.evil", "192.168.1.1", "::ffff:192.168.1.1"})
        assert(!Authorized(true, address));

    assert(InBounds(1, -6235, -3945, -58, 0));
    assert(InBounds(1, -6500, -4500, -65, 6.283f));
    assert(!InBounds(0, -6235, -3945, -58, 0));
    assert(!InBounds(1, -6501, -3945, -58, 0));
    assert(!InBounds(1, -5699, -3945, -58, 0));
    assert(!InBounds(1, -6235, -4501, -58, 0));
    assert(!InBounds(1, -6235, -3299, -58, 0));
    assert(!InBounds(1, -6235, -3945, -66, 0));
    assert(!InBounds(1, -6235, -3945, -44, 0));
    assert(!InBounds(1, -6235, -3945, -58, -0.1f));
    assert(!InBounds(1, -6235, -3945, -58, 6.3f));
    assert(!InBounds(1, nan, -3945, -58, 0));
    assert(!InBounds(1, -6235, inf, -58, 0));
    assert(!InBounds(1, -6235, -3945, nan, 0));
    assert(!InBounds(1, -6235, -3945, -58, inf));
    assert(OnTrack(439, -58, -58));
    assert(-58.75f + ResetGroundClearance == -58.5f);
    assert(InBounds(1, -6235, -3945, -58.75f + ResetGroundClearance, 0));
    assert(OnTrack(439, -58.75f + ResetGroundClearance, -58.75f));
    assert(!InBounds(1, -6235, -3945, -45.0f + ResetGroundClearance, 0));
    assert(OnTrack(2240, -52, -58));
    assert(InBounds(1, -6223.51f, -3925.04f, -58.7415f, 1.89126f));
    assert(OnTrack(2240, -58.7415f, -58.7517f));
    assert(!OnTrack(479, -58, -58));
    assert(!OnTrack(400, -58, -58));
    assert(!OnTrack(439, -51.9f, -58));
    assert(!OnTrack(439, -59, -58));
    assert(!OnTrack(439, -58, -100000));
    assert(!OnTrack(439, -58, nan));
    assert(!OnTrack(439, nan, -58));
    assert(!OnTrack(2240, -58, inf));
    assert(PlainMovement(0, {0, 1, -1}));
    assert(PlainMovement(0x3f, {}));
    for (unsigned bit = 6; bit < 32; ++bit)
        assert(!PlainMovement(std::uint32_t(1) << bit, {}));
    assert(!PlainMovement(0, {nan}));
    assert(!PlainMovement(0, {inf}));

    MotionBudget budget;
    budget.Reset(1000);
    assert(budget.Consume(1000, 6, 0, 2));
    assert(!budget.Consume(1000, 0.01f, 0, 0));
    assert(!budget.Consume(1000, 0, 0, 0.01f));
    assert(budget.Consume(1100, 6, 0, -2));
    assert(!budget.Consume(1200, 6.01f, 0, 0));
    assert(budget.Consume(1200, 0, 6, 2));
    assert(!budget.Consume(1300, 5, 5, 0)); // Euclidean, not independent axis budgets.
    assert(!budget.Consume(1300, 0, 0, 2.01f));
    assert(budget.Consume(1300, 6, 0, 0));
    assert(!budget.Consume(60000, 15.01f, 0, 0)); // Idle cannot bank a teleport.
    assert(budget.Consume(60000, 15, 0, 5));
    assert(!budget.Consume(60000, 0.01f, 0, 0));
    assert(!budget.Consume(60100, nan, 0, 0));
    assert(!budget.Consume(60100, 0, inf, 0));
    assert(!budget.Consume(60100, 0, 0, nan));
    budget.Reset(0xfffffff0u);
    assert(budget.Consume(84, 12, 0, 4)); // Server clock wraparound.
}

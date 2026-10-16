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

    // Even consecutive packets can span the region: elapsed time is not a policy input.
    struct Endpoint { float x, y, z, ground; };
    Endpoint const endpoints[] = {
        {-6500, -4500, -65, -65},
        {-5700, -3300, -45, -45},
        {-6235, -3945, -58.75f, -58.75f},
        {-6100, -3800, -52.75f, -58.75f},
        {-6235, -3945, -58.75f, -58.75f},
    };
    for (auto const& endpoint : endpoints)
    {
        assert(InBounds(1, endpoint.x, endpoint.y, endpoint.z, 0));
        assert(OnTrack(439, endpoint.z, endpoint.ground));
        assert(PlainMovement(1, {0, 0, 0, 0, 0, 0, 0, 0, 0, 0}));
    }
    assert(endpoints[1].x - endpoints[0].x == 800);
    assert(endpoints[1].y - endpoints[0].y == 1200);
    assert(endpoints[1].z - endpoints[0].z == 20);
    // Tunable hover/hop still cannot exceed either geometric height boundary.
    assert(!OnTrack(439, -52.74f, -58.75f));
    assert(!InBounds(1, -6235, -3945, -44.99f, 0));
}

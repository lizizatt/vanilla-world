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

    assert(WorldMap(0));
    assert(WorldMap(1));
    for (std::uint32_t map : {2u, 30u, 33u, 489u, 530u, 0xffffffffu})
        assert(!WorldMap(map));
    assert(FinitePosition(-6235, -3945, -58, 0));
    assert(FinitePosition(-6501, -4501, -66, 6.283f));
    assert(FinitePosition(10000, 12000, 10000, 0));
    assert(!FinitePosition(0, 0, 0, -0.1f));
    assert(!FinitePosition(0, 0, 0, 6.3f));
    assert(!FinitePosition(nan, 0, 0, 0));
    assert(!FinitePosition(0, inf, 0, 0));
    assert(!FinitePosition(0, 0, nan, 0));
    assert(!FinitePosition(0, 0, 0, inf));
    float const invalidHeight = -100000.0f;
    assert(AboveGround(-58, -58, invalidHeight));
    assert(-58.75f + ResetGroundClearance == -58.5f);
    assert(AboveGround(-58.75f + ResetGroundClearance, -58.75f, invalidHeight));
    assert(AboveGround(-58.75f, -58.0f, invalidHeight));
    assert(!AboveGround(-58.76f, -58.0f, invalidHeight));
    assert(AboveGround(40000, -58, invalidHeight));
    assert(AboveGround(1200, 1100, invalidHeight));
    assert(AboveGround(-500, -501, invalidHeight));
    assert(!AboveGround(-58, invalidHeight, invalidHeight));
    assert(!AboveGround(-58, -200000, invalidHeight));
    assert(!AboveGround(-58, nan, invalidHeight));
    assert(!AboveGround(nan, -58, invalidHeight));
    assert(!AboveGround(inf, -58, invalidHeight));
    assert(!AboveGround(-58, inf, invalidHeight));
    assert(PlainMovement(0, {0, 1, -1}));
    assert(PlainMovement(0x3f, {}));
    for (unsigned bit = 6; bit < 32; ++bit)
        assert(!PlainMovement(std::uint32_t(1) << bit, {}));
    assert(!PlainMovement(0, {nan}));
    assert(!PlainMovement(0, {inf}));

    // World endpoints and ballistic hops have no racer-specific distance or altitude cap.
    struct Endpoint { float x, y, z, ground; };
    Endpoint const endpoints[] = {
        {-6500, -4500, -65, -65},
        {-5700, -3300, -45, -45},
        {-6235, -3945, -58.75f, -58.75f},
        {10000, 12000, 1200, 1100},
        {-9000, 9000, 20000, -500},
        {-6100, -3800, -52.75f, -58.75f},
        {-6235, -3945, -58.75f, -58.75f},
    };
    for (auto const& endpoint : endpoints)
    {
        assert(FinitePosition(endpoint.x, endpoint.y, endpoint.z, 0));
        assert(AboveGround(endpoint.z, endpoint.ground, invalidHeight));
        assert(PlainMovement(1, {0, 0, 0, 0, 0, 0, 0, 0, 0, 0}));
    }
    assert(endpoints[1].x - endpoints[0].x == 800);
    assert(endpoints[1].y - endpoints[0].y == 1200);
    assert(endpoints[1].z - endpoints[0].z == 20);
    // The integration must additionally enforce engine coordinates, loaded tiles and outdoor ground.
}

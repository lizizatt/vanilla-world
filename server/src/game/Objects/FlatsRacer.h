#ifndef MANGOS_FLATS_RACER_H
#define MANGOS_FLATS_RACER_H

#include <cmath>
#include <cstdint>
#include <initializer_list>
#include <string>

namespace FlatsRacer
{
    constexpr bool DefaultEnabled = false;
    constexpr std::uint32_t MountDisplayId = 10318;
    constexpr float ResetGroundClearance = 0.25f;
    constexpr float MovementGroundTolerance = 3.0f;

    inline bool Authorized(bool enabled, std::string const& address)
    {
        return enabled &&
            (address == "127.0.0.1" || address == "::1" || address == "::ffff:127.0.0.1");
    }

    inline bool WorldMap(std::uint32_t map)
    {
        return map == 0 || map == 1;
    }

    inline bool FinitePosition(float x, float y, float z, float orientation)
    {
        return std::isfinite(x) && std::isfinite(y) &&
            std::isfinite(z) && std::isfinite(orientation) &&
            orientation >= 0.0f && orientation <= 6.284f;
    }

    inline bool AboveGround(float z, float ground, float invalidHeight, float tolerance = 0.75f)
    {
        return std::isfinite(z) && std::isfinite(ground) &&
            ground > invalidHeight && std::isfinite(tolerance) && tolerance >= 0.0f &&
            z >= ground - tolerance;
    }

    inline bool PlainMovement(std::uint32_t flags, std::initializer_list<float> values)
    {
        if (flags & ~std::uint32_t(0x3f))
            return false;
        for (float value : values)
            if (!std::isfinite(value))
                return false;
        return true;
    }
}

#endif

#ifndef MANGOS_FLATS_RACER_H
#define MANGOS_FLATS_RACER_H

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <initializer_list>
#include <string>

namespace FlatsRacer
{
    constexpr bool DefaultEnabled = false;
    constexpr std::uint32_t MountDisplayId = 10318;
    constexpr float ResetGroundClearance = 0.25f;
    constexpr float MaxSpeed = 60.0f;
    constexpr float MaxVerticalSpeed = 20.0f;
    constexpr float MaxBudgetSeconds = 0.25f;

    inline bool Authorized(bool enabled, std::string const& address)
    {
        return enabled &&
            (address == "127.0.0.1" || address == "::1" || address == "::ffff:127.0.0.1");
    }

    inline bool InBounds(std::uint32_t map, float x, float y, float z, float orientation)
    {
        return map == 1 && std::isfinite(x) && std::isfinite(y) &&
            std::isfinite(z) && std::isfinite(orientation) &&
            x >= -6500.0f && x <= -5700.0f && y >= -4500.0f && y <= -3300.0f &&
            z >= -65.0f && z <= -45.0f && orientation >= 0.0f && orientation <= 6.284f;
    }

    inline bool OnTrack(std::uint32_t area, float z, float ground)
    {
        return (area == 439 || area == 2240) && std::isfinite(ground) &&
            ground >= -65.0f && ground <= -45.0f && z >= ground - 0.75f && z <= ground + 6.0f;
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

    struct MotionBudget
    {
        std::uint32_t time = 0;
        float horizontal = 0.0f;
        float vertical = 0.0f;

        void Reset(std::uint32_t now)
        {
            time = now;
            horizontal = MaxSpeed * 0.1f;
            vertical = MaxVerticalSpeed * 0.1f;
        }

        bool Consume(std::uint32_t now, float dx, float dy, float dz)
        {
            if (!std::isfinite(dx) || !std::isfinite(dy) || !std::isfinite(dz))
                return false;
            float const seconds = std::min(float(std::uint32_t(now - time)) / 1000.0f, MaxBudgetSeconds);
            float const availableXY = std::min(horizontal + MaxSpeed * seconds, MaxSpeed * MaxBudgetSeconds);
            float const availableZ = std::min(vertical + MaxVerticalSpeed * seconds, MaxVerticalSpeed * MaxBudgetSeconds);
            float const distanceXY = std::hypot(dx, dy);
            if (distanceXY > availableXY || std::fabs(dz) > availableZ)
                return false;
            time = now;
            horizontal = availableXY - distanceXY;
            vertical = availableZ - std::fabs(dz);
            return true;
        }
    };
}

#endif

-- Original instruments for the opt-in racer; the stock HUD stays intact.
if not FlatsRacerHUD then
    local f = CreateFrame("Frame", "FlatsRacerHUD", UIParent)
    f:SetWidth(620) f:SetHeight(152)
    f:SetPoint("BOTTOM", UIParent, "BOTTOM", 0, 130)
    f:SetFrameStrata("MEDIUM")
    f:EnableMouse(false)

    local amber = {1, 0.70, 0.30}
    local teal = {0.30, 0.86, 0.80}
    local muted = {0.55, 0.65, 0.67}
    local function plate(parent, x, y, w, h, r, g, b, a)
        local t = parent:CreateTexture(nil, "BACKGROUND")
        t:SetPoint("TOPLEFT", parent, "TOPLEFT", x, y)
        t:SetWidth(w) t:SetHeight(h)
        t:SetTexture(r, g, b, a)
        return t
    end
    local function label(name, x, y, w, h, size, color, text)
        local t = f:CreateFontString(name, "OVERLAY")
        t:SetPoint("TOPLEFT", f, "TOPLEFT", x, y)
        t:SetWidth(w) t:SetHeight(h)
        t:SetFont("Fonts\\ARIALN.TTF", size)
        t:SetJustifyH("LEFT") t:SetJustifyV("TOP")
        t:SetTextColor(color[1], color[2], color[3], 1)
        t:SetText(text)
        return t
    end
    plate(f, 0, 0, 620, 152, 0.02, 0.05, 0.06, 0.88)
    plate(f, 0, 0, 620, 2, 0.25, 0.53, 0.53, 0.9)
    plate(f, 0, 0, 4, 94, amber[1], amber[2], amber[3], 1)
    plate(f, 616, 0, 4, 94, teal[1], teal[2], teal[3], 1)
    plate(f, 18, -98, 584, 1, 0.25, 0.40, 0.42, 0.8)
    label(nil, 18, -10, 250, 15, 11, muted, "TWIN DRIVE  /  HOVER TELEMETRY")
    label("FlatsRacerHUDSpeed", 18, -29, 108, 37, 34, amber, "000")
    label("FlatsRacerHUDDirection", 132, -37, 50, 18, 13, amber, "IDLE")
    label(nil, 20, -71, 140, 16, 10, muted, "VELOCITY  /  YD/S")
    label("FlatsRacerHUDState", 200, -13, 208, 20, 14, teal, "STANDBY")
    label("FlatsRacerHUDText", 200, -39, 208, 45, 12, muted, "")
    label(nil, 438, -13, 155, 15, 11, muted, "BOOST RESERVE")
    label("FlatsRacerHUDBoost", 438, -32, 160, 25, 24, teal, "100%")
    label("FlatsRacerHUDHint", 18, -109, 398, 34, 11, muted, "")

    local function segments(x, y, count, width, color)
        local parts = {}
        for i = 1, count do
            local t = plate(f, x + (i - 1) * (width + 3), y, width, 8,
                color[1], color[2], color[3], 1)
            parts[i] = t
        end
        return parts
    end
    f.speedSegments = segments(20, -88, 12, 11, amber)
    f.boostSegments = segments(438, -71, 12, 10, teal)

    local function button(name, x, text, click)
        local b = CreateFrame("Button", name, f)
        b:SetWidth(77) b:SetHeight(27)
        b:SetPoint("TOPLEFT", f, "TOPLEFT", x, -113)
        b:EnableMouse(true)
        local bg = plate(b, 0, 0, 77, 27, 0.10, 0.22, 0.23, 1)
        local t = b:CreateFontString(nil, "OVERLAY")
        t:SetPoint("CENTER", b, "CENTER", 0, 0)
        t:SetFont("Fonts\\ARIALN.TTF", 11)
        t:SetTextColor(teal[1], teal[2], teal[3], 1)
        t:SetText(text)
        b:SetScript("OnEnter", function() bg:SetTexture(0.18, 0.34, 0.34, 1) end)
        b:SetScript("OnLeave", function() bg:SetTexture(0.10, 0.22, 0.23, 1) end)
        b:SetScript("OnClick", click)
    end
    button("FlatsRacerTuneToggle", 438, "TUNING", function() FlatsRacerTuneCommand = "toggle" end)
    button("FlatsRacerHelpToggle", 525, "CONTROLS", function()
        f.helpOpen = not f.helpOpen
        if f.helpOpen then f.help:Show() else f.help:Hide() end
    end)
    local help = CreateFrame("Frame", "FlatsRacerHUDHelp", f)
    help:SetWidth(620) help:SetHeight(65)
    help:SetPoint("BOTTOM", f, "TOP", 0, 6)
    plate(help, 0, 0, 620, 65, 0.02, 0.05, 0.06, 0.94)
    local text = help:CreateFontString("FlatsRacerHUDControls", "OVERLAY")
    text:SetPoint("TOPLEFT", help, "TOPLEFT", 14, -10)
    text:SetWidth(592) text:SetHeight(48)
    text:SetFont("Fonts\\ARIALN.TTF", 12)
    text:SetJustifyH("LEFT")
    text:SetTextColor(teal[1], teal[2], teal[3], 1)
    help:Hide()
    f.help = help

    function FlatsRacerHUDUpdate(speed, speedFraction, boost, direction, state, status, hint, controls)
        f:Show()
        if speed < 10000 then
            FlatsRacerHUDSpeed:SetText(string.format("%03.0f", speed))
        else
            FlatsRacerHUDSpeed:SetText(string.format("%.1e", speed))
        end
        FlatsRacerHUDDirection:SetText(direction)
        FlatsRacerHUDState:SetText(state)
        FlatsRacerHUDText:SetText(status)
        FlatsRacerHUDHint:SetText(hint)
        FlatsRacerHUDControls:SetText(controls)
        FlatsRacerHUDBoost:SetText(string.format("%.0f%%", boost * 100))
        local warning = state == "COLLISION HOLD" or state == "STANDBY"
        if warning then FlatsRacerHUDState:SetTextColor(1, 0.70, 0.30, 1)
        else FlatsRacerHUDState:SetTextColor(0.30, 0.86, 0.80, 1) end
        for i = 1, 12 do
            f.speedSegments[i]:SetAlpha(i / 12 <= speedFraction and 1 or 0.15)
            f.boostSegments[i]:SetAlpha(i / 12 <= boost and 1 or 0.15)
        end
    end
end

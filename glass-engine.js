(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.GlassEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

// =========================
// MT Busel v3 defaults (global config)
// =========================
// You can override per-call by passing fields into calcBuselV3Piece(p),
// or globally via GlassEngine.setBuselConfig({...}).
let BUSEL_CFG = {
  // Business rule: MT glass is tempered by default
  tempered: true,

  // Billing area minimum per piece (m²)
  minAreaM2: 0.25,

  // Temper minimums (UAH) per ONE glass type/thickness in the order
  temperMinFloatUAH: 750,
  temperMinOtherUAH: 999,

  // MT pricing modifiers
  mtDiscount: 0.85, // -15%
  mtMarkup: 1.30,   // +30%

  // Optional size surcharge application
  applySizeSurcharge: false
};

function setBuselConfig(patch) {
  if (!patch || typeof patch !== "object") return BUSEL_CFG;
  BUSEL_CFG = { ...BUSEL_CFG, ...patch };
  return BUSEL_CFG;
}


  // -------------------------
  // utils
  // -------------------------
  function clamp0(x) {
    x = Number(x);
    return Number.isFinite(x) ? Math.max(0, x) : 0;
  }

  function mm2_to_m2(wMm, hMm) {
    return (clamp0(wMm) * clamp0(hMm)) / 1_000_000;
  }

  function perimeter_m(wMm, hMm) {
    return (2 * (clamp0(wMm) + clamp0(hMm))) / 1000;
  }

  function round2(x) {
    return Math.round((Number(x) + Number.EPSILON) * 100) / 100;
  }

  // -------------------------
  // Busel coefficients
  // -------------------------
  function areaCoef(billingAreaM2) {
    const a = clamp0(billingAreaM2);
    if (a >= 7.5) return 2.0;
    if (a >= 6.5) return 1.5;
    if (a >= 5.5) return 1.3;
    if (a >= 4.5) return 1.2;
    if (a >= 3.5) return 1.1;
    return 1.0;
  }

  /**
   * Batch coefficient for tempering party.
   * (Keep same logic as Volpato calculator. Adjust later if you confirm exact table.)
   */
  function batchCoefTempered(totalAreaM2) {
    const a = clamp0(totalAreaM2);
    if (a < 0.25) return 2.0;
    if (a < 2.0) return 1.5;
    if (a < 10.0) return 1.3;
    if (a < 50.0) return 1.1;
    if (a <= 100.0) return 1.05;
    return 1.0;
  }

  /**
   * Size surcharge for pre-processing (optional, based on one side length).
   * If you don't need it now — keep enabled=false in options.
   */
  function sizeSurchargeCoef(p) {
    const wMm = clamp0(p && p.wMm);
    const hMm = clamp0(p && p.hMm);
    const maxSide = Math.max(wMm, hMm);
    if (maxSide >= 3200) return 1.50;
    if (maxSide >= 2800) return 1.35;
    if (maxSide >= 2200) return 1.20;
    return 1.00;
  }

  // -------------------------
  // Core pricing
  // -------------------------

  /**
   * Calculate Busel-based glass cost for given piece geometry.
   *
   * @param {object} p
   * @param {number} p.widthMm
   * @param {number} p.heightMm
   * @param {number} p.qty
   * @param {number} p.materialPricePerM2UAH     - Busel base material price, UAH/m²
   * @param {number} p.edgePolishPerMUAH         - polishing price, UAH/m (can be 0)
   * @param {boolean} [p.tempered=true]          - we treat ALL glass as tempered in MT projects
   * @param {number} [p.temperTariffPerM2UAH=0]  - Busel tempering tariff, UAH/m² for this glass type/thickness
   * @param {"float"|"other"} [p.temperMinType="other"] - which min order to use
   * @param {number} [p.temperMinFloatUAH=750]
   * @param {number} [p.temperMinOtherUAH=999]
   * @param {boolean} [p.applySizeSurcharge=false]
   * @returns {object} breakdown
   */
  function calcBuselV3Piece(p) {
    const widthMm = clamp0(p && p.widthMm);
    const heightMm = clamp0(p && p.heightMm);
    const qty = Math.max(1, Math.floor(clamp0((p && p.qty) || 1)));

    const materialPricePerM2UAH = clamp0(p && p.materialPricePerM2UAH);
    const edgePolishPerMUAH = clamp0(p && p.edgePolishPerMUAH);

    const rawArea = mm2_to_m2(widthMm, heightMm);
    const billingArea = Math.max(rawArea, (BUSEL_CFG && BUSEL_CFG.minAreaM2) ? BUSEL_CFG.minAreaM2 : 0.25);

    const kArea = areaCoef(billingArea);

    // material + polish (Busel base)
    const materialUAH = billingArea * materialPricePerM2UAH;
    const edgeLenM = perimeter_m(widthMm, heightMm);
    const polishUAH = edgeLenM * edgePolishPerMUAH;

    // optional size surcharge (for pre-processing). Apply to (material+polish) only (safe default).
    const kSize = ((p && typeof p.applySizeSurcharge === "boolean") ? p.applySizeSurcharge : (BUSEL_CFG ? !!BUSEL_CFG.applySizeSurcharge : false))
      ? sizeSurchargeCoef({ wMm: widthMm, hMm: heightMm }) : 1.0;
    const buselBaseUAH = (materialUAH + polishUAH) * kSize;

    // tempering
    const tempered = (p && p.tempered === false) ? false : ((p && typeof p.tempered === "boolean") ? p.tempered : (BUSEL_CFG ? !!BUSEL_CFG.tempered : true));
    const temperTariffPerM2UAH = clamp0((p && p.temperTariffPerM2UAH) || 0);

    let temperTotalUAH = 0;
    let kBatch = 1.0;
    let temperMinUAH = 0;

    if (tempered && temperTariffPerM2UAH > 0) {
      const partyArea = billingArea * qty;
      kBatch = batchCoefTempered(partyArea);

      temperTotalUAH = temperTariffPerM2UAH * billingArea * kArea * qty * kBatch;

      const minFloat = clamp0((p && p.temperMinFloatUAH) != null ? p.temperMinFloatUAH : (BUSEL_CFG && BUSEL_CFG.temperMinFloatUAH != null ? BUSEL_CFG.temperMinFloatUAH : 750));
      const minOther = clamp0((p && p.temperMinOtherUAH) != null ? p.temperMinOtherUAH : (BUSEL_CFG && BUSEL_CFG.temperMinOtherUAH != null ? BUSEL_CFG.temperMinOtherUAH : 999));
      temperMinUAH = ((p && p.temperMinType) === "float") ? minFloat : minOther;

      if (temperTotalUAH < temperMinUAH) temperTotalUAH = temperMinUAH;
    }

    const buselNetUAH = buselBaseUAH + temperTotalUAH;

    // MT pricing: -15% then +30%
    const mtNetUAH = buselNetUAH * (BUSEL_CFG && BUSEL_CFG.mtDiscount ? BUSEL_CFG.mtDiscount : 0.85);
    const mtRetailUAH = mtNetUAH * (BUSEL_CFG && BUSEL_CFG.mtMarkup ? BUSEL_CFG.mtMarkup : 1.30);

    // per-piece for UI/debug
    const mtRetailPerPieceUAH = mtRetailUAH / qty;

    return {
      widthMm: widthMm,
      heightMm: heightMm,
      qty: qty,
      rawArea: rawArea,
      billingArea: billingArea,
      edgeLenM: edgeLenM,
      kArea: kArea,
      kBatch: kBatch,
      kSize: kSize,
      materialUAH: materialUAH,
      polishUAH: polishUAH,
      temperTariffPerM2UAH: temperTariffPerM2UAH,
      temperMinUAH: temperMinUAH,
      temperTotalUAH: temperTotalUAH,
      buselNetUAH: buselNetUAH,
      mtRetailUAH: mtRetailUAH,
      mtRetailPerPieceUAH: mtRetailPerPieceUAH
    };
  }

  // -------------------------
  // ONLY sizing helpers
  // -------------------------

  /**
   * ONLY side glass (4 mm) per section:
   *   Hglass = Hmont
   *   Lglass = D - 3.5
   */
  function onlySideGlass4mm(p) {
    const H = clamp0(p && p.HmontMm);
    const D = clamp0(p && p.depthMm);
    const sections = Math.max(1, Math.floor(clamp0((p && p.sectionsCount) || 1)));

    const sideMode = (p && p.sideMode) || "none";
    const sidesCount =
      (sideMode === "both") ? 2 :
      (sideMode === "left" || sideMode === "right") ? 1 : 0;

    const wMm = Math.max(0, D - 3.5);
    const hMm = H;

    const oneArea = mm2_to_m2(wMm, hMm);
    const totalPieces = sections * sidesCount;
    const totalArea = oneArea * totalPieces;

    return {
      thicknessMm: 4,
      perPiece: { wMm: wMm, hMm: hMm, areaM2: oneArea },
      total: { pieces: totalPieces, areaM2: totalArea },
      text: "Бокове скло 4 мм: " + sections + "×" + sidesCount +
        "×(" + wMm + "×" + hMm + " мм) = " + round2(totalArea) + " м²"
    };
  }

  /**
   * ONLY back panel per section:
   *  glass 6mm:  Wback = Lvano + 11; Hback = Hmont - 38
   *  board 8mm:  Wback = Lvano + 16; Hback = Hmont - 38
   *
   * Lvano is the clear section width (span).
   */
  function onlyBackPanel(p) {
    const Lvano = clamp0(p && p.spanMm);
    const Hmont = clamp0(p && p.HmontMm);

    const material = (p && p.material) || "";
    const isGlass6 = (material === "glass6");
    const isBoard8 = (material === "board8");

    if (!isGlass6 && !isBoard8) return null;

    const addW = isGlass6 ? 11 : 16;
    const wMm = Math.max(0, Lvano + addW);
    const hMm = Math.max(0, Hmont - 38);
    const tMm = isGlass6 ? 6 : 8;

    const area = mm2_to_m2(wMm, hMm);

    return {
      thicknessMm: tMm,
      perPiece: { wMm: wMm, hMm: hMm, areaM2: area },
      text: (isGlass6 ? "Спинка скло 6 мм" : "Спинка ДСП/МДФ 8 мм") +
        ": 1×(" + wMm + "×" + hMm + " мм) = " + round2(area) + " м²"
    };
  }

  // -------------------------
  // Public API
  // -------------------------
  return {
    calcBuselV3Piece: calcBuselV3Piece,
    areaCoef: areaCoef,
    batchCoefTempered: batchCoefTempered,
    sizeSurchargeCoef: sizeSurchargeCoef,
    onlySideGlass4mm: onlySideGlass4mm,
    onlyBackPanel: onlyBackPanel,
    mm2_to_m2: mm2_to_m2,
    perimeter_m: perimeter_m,
    BUSEL_CFG: BUSEL_CFG,
    setBuselConfig: setBuselConfig
  };
});
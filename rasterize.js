/*
 * Copyright Olli Etuaho 2012-2013.
 */

/**
 * A base object for a rasterizer that can blend together monochrome circles and
 * draw gradients. Do not instance this directly.
 * Inheriting objects are expected to implement fillCircle(x, y, radius),
 * getPixel(coords), clear(), linearGradient(coords1, coords0) and if need be,
 * flushCircles() and free().
 * @constructor
 */
var BaseRasterizer = function() {};

/**
 * Initialize the generic rasterizer data.
 * @param {number} width Width of the rasterizer bitmap in pixels.
 * @param {number} height Height of the rasterizer bitmap in pixels.
 */
BaseRasterizer.prototype.initBaseRasterizer = function(width, height) {
    this.clipRect = new Rect(0, width, 0, height);
    this.width = width;
    this.height = height;
    this.soft = false;
    this.flowAlpha = 0; // range [0, 1]
    this.prevX = null;
    this.prevY = null;
    this.prevR = null;
    this.t = 0;
    this.drawEvent = null;
    this.drawEventState = null;
    this.drawEventClipRect = new Rect(0, this.width, 0, this.height);
    this.dirtyArea = new Rect();
};

/**
 * Set the clipping rectangle.
 * @param {Rect} rect The new clipping rectangle.
 */
BaseRasterizer.prototype.setClip = function(rect) {
    this.clipRect.set(0, this.width, 0, this.height);
    this.clipRect.intersectRect(rect);
};

/**
 * Reset the clipping rectangle.
 */
BaseRasterizer.prototype.resetClip = function() {
    this.clipRect.set(0, this.width, 0, this.height);
};

/**
 * Clear all the pixels that have been touched by draw operations, disregarding
 * current clipping rectangle.
 */
BaseRasterizer.prototype.clearDirty = function() {
    if (!this.dirtyArea.isEmpty()) {
        var restoreClip = new Rect();
        restoreClip.setRect(this.clipRect);
        this.setClip(this.dirtyArea);
        this.clear();
        this.setClip(restoreClip);
        this.dirtyArea.makeEmpty();
    }
    this.drawEvent = null;
};

/**
 * Get draw event state for the given event. The draw event state represents
 * what parts of the event have been rasterized to this rasterizer's bitmap.
 * Assumes that the intention is to rasterize the given event, and clears any
 * previous events from the rasterizer.
 * @param {PictureEvent} event The event to be rasterized.
 * @param {function()} stateConstructor Constructor for creating a new draw
 * event state object unless the event already has been rasterized to this
 * rasterizer's bitmap.
 * @return {Object} Draw event state for the given event.
 */
BaseRasterizer.prototype.getDrawEventState = function(event, stateConstructor) {
    if (event !== this.drawEvent ||
        !this.drawEventClipRect.containsRect(this.clipRect)) {
        this.clearDirty();
        this.drawEvent = event;
        this.drawEventState = new stateConstructor();
    }
    this.drawEventClipRect.setRect(this.clipRect);
    return this.drawEventState;
};

/**
 * Initialize drawing circle lines with the given parameters.
 * @param {boolean} soft Use soft edged circles.
 * @param {number} flowAlpha The alpha value to use to rasterize individual
 * circles.
 */
BaseRasterizer.prototype.beginCircleLines = function(soft, flowAlpha) {
    this.soft = soft;
    this.minRadius = this.soft ? 1.0 : 0.5;
    this.flowAlpha = flowAlpha;
    this.prevX = null;
    this.prevY = null;
    this.prevR = null;
    this.t = 0;
};

/**
 * Draw a series of circles from the current point and radius to the given point
 * and radius. Radius, x, and y values for circles along the line are
 * interpolated linearly from the previous parameters to this function. Circles
 * are placed at 1 pixel intervals along the path, a circle doesn't necessarily
 * end up exactly at the end point. On the first call, doesn't draw anything.
 * @param {number} centerX The x coordinate of the center of the circle at the
 * end of the line.
 * @param {number} centerY The y coordinate of the center of the circle at the
 * end of the line.
 * @param {number} radius The radius at the end of the line.
 */
BaseRasterizer.prototype.circleLineTo = function(centerX, centerY, radius) {
    if (this.prevX !== null) {
        var diff = new Vec2(centerX - this.prevX, centerY - this.prevY);
        var d = diff.length();
        while (this.t < d) {
            this.fillCircle(this.prevX + diff.x * (this.t / d),
                            this.prevY + diff.y * (this.t / d),
                            this.prevR + (radius - this.prevR) * (this.t / d));
            this.t++;
        }
        this.t -= d;
    }
    this.prevX = centerX;
    this.prevY = centerY;
    this.prevR = radius;
};

/**
 * Get the actual radius of the drawn circle when the appearance of the given
 * radius is desired. Very small circles get drawn with the minimum radius with
 * reduced alpha to avoid aliasing.
 * @param {number} radius The radius of the circle.
 * @return {number} The actual draw radius to use.
 */
BaseRasterizer.prototype.drawRadius = function(radius) {
    return Math.max(radius, this.minRadius);
};

/**
 * Get the bounding radius for drawing a circle of the given radius. This covers
 * the antialiasing boundaries of the circle.
 * @param {number} radius The radius of the circle.
 * @return {number} The draw radius for the purposes of antialiasing.
 */
BaseRasterizer.prototype.drawBoundingRadius = function(radius) {
    return Math.max(radius, this.minRadius) + 1.0;
};

/**
 * Get the actual alpha of the drawn circle when the appearance of the given
 * radius is desired. Very small circles get drawn with the minimum radius with
 * reduced alpha to avoid aliasing.
 * @param {number} radius The radius of the circle.
 * @return {number} The actual alpha value to use.
 */
BaseRasterizer.prototype.drawAlpha = function(radius) {
    return this.flowAlpha *
           Math.pow(Math.min(radius / this.minRadius, 1.0), 2.0);
};

/**
 * Flush all circle drawing commands that have been given to the bitmap.
 */
BaseRasterizer.prototype.flushCircles = function() {
};

/**
 * Clean up any allocated resources. The rasterizer is not usable after this.
 */
BaseRasterizer.prototype.free = function() {
};

/**
 * Do a basic sanity check by drawing things and reading back the pixels,
 * checking that they're roughly within the expected boundaries.
 * @return {boolean} The test showed expected results.
 */
BaseRasterizer.prototype.checkSanity = function() {
    var i, pix;
    this.drawEvent = null;
    this.resetClip();
    this.clear();
    this.beginCircleLines(false, 1.0);
    this.circleLineTo(1.5, 1.5, 2.0);
    this.circleLineTo(4.5, 4.5, 2.0);
    this.flushCircles();
    for (i = 1; i <= 4; ++i) {
        pix = this.getPixel(new Vec2(i, i));
        if (this.getPixel(new Vec2(i, i)) < 0.995) {
            console.log('Pixel rendered with flow 1.0 was ' + pix);
            return false;
        }
    }
    this.clear();
    this.beginCircleLines(false, 0.5);
    this.circleLineTo(3.5, 3.5, 2.0);
    this.circleLineTo(13.5, 13.5, 2.0);
    this.flushCircles();
    var lastPix = -1.0;
    for (i = 3; i <= 9; ++i) {
        pix = this.getPixel(new Vec2(i, i));
        if (pix < 0.6 || pix > 0.95) {
            console.log('Pixel rendered with flow 0.5 was ' + pix);
            return false;
        }
        if (pix < lastPix - 0.05) {
            console.log('Pixel rendered with flow 0.5 changed from ' +
                        lastPix + ' to ' + pix +
                        ' when progressing along the brush stroke');
            return false;
        }
        lastPix = pix;
    }
    this.clear();
    return true;
};


/**
 * A javascript-based rasterizer.
 * @constructor
 * @param {number} width Width of the rasterizer bitmap in pixels.
 * @param {number} height Height of the rasterizer bitmap in pixels.
 */
var Rasterizer = function(width, height) {
    this.initBaseRasterizer(width, height);
    this.buffer = new ArrayBuffer(width * height * 4);
    this.data = new Float32Array(this.buffer);
    this.clear();
};

Rasterizer.prototype = new BaseRasterizer();

/**
 * @return {number} The GPU memory usage of this rasterizer in bytes.
 */
Rasterizer.prototype.getMemoryBytes = function() {
    return 0;
};

/**
 * Draw the rasterizer's contents to the given bitmap.
 * @param {ImageData} targetData The buffer to draw to.
 * @param {Uint8Array|Array.<number>} color Color to use for drawing. Channel
 * values should be 0-255.
 * @param {number} opacity Opacity to use when drawing the rasterization result.
 * Opacity for each individual pixel is its rasterized opacity times this
 * opacity value.
 * @param {number} x Left edge of the area to copy to targetData. Must be an
 * integer.
 * @param {number} y Top edge of the area to copy to targetData. Must be an
 * integer.
 * @param {number} w Width of the targetData buffer and the area to copy there.
 * Must be an integer.
 * @param {number} h Height of the targetData buffer and the area to copy there.
 * Must be an integer.
 */
Rasterizer.prototype.drawWithColor = function(targetData, color, opacity,
                                              x, y, w, h) {
    var tData = targetData.data;
    for (var yi = 0; yi < h; ++yi) {
        var ind = yi * w * 4;
        var sind = x + (y + yi) * this.width;
        for (var xi = 0; xi < w; ++xi) {
            var alphaT = tData[ind + 3] / 255;
            var alphaS = this.data[sind] * opacity;
            var tMult = alphaT * (1.0 - alphaS);
            var alpha = alphaS + tMult;
            tData[ind] = (tData[ind] * tMult + color[0] * alphaS) / alpha;
            tData[ind + 1] = (tData[ind + 1] * tMult + color[1] * alphaS) /
                             alpha;
            tData[ind + 2] = (tData[ind + 2] * tMult + color[2] * alphaS) /
                             alpha;
            tData[ind + 3] = 255 * alpha;
            ind += 4;
            ++sind;
        }
    }
};

/**
 * Erase the rasterizer's contents from the given bitmap.
 * @param {ImageData} targetData The buffer to erase from.
 * @param {number} opacity Opacity to use when erasing the rasterization result.
 * Opacity for each individual pixel is its rasterized opacity times this
 * opacity value.
 * @param {number} x Left edge of the area to copy to targetData. Must be an
 * integer.
 * @param {number} y Top edge of the area to copy to targetData. Must be an
 * integer.
 * @param {number} w Width of the targetData buffer and the area to copy there.
 * Must be an integer.
 * @param {number} h Height of the targetData buffer and the area to copy there.
 * Must be an integer.
 */
Rasterizer.prototype.erase = function(targetData, opacity, x, y, w, h) {
    var tData = targetData.data;
    for (var yi = 0; yi < h; ++yi) {
        var ind = yi * w * 4;
        var sind = x + (y + yi) * this.width;
        for (var xi = 0; xi < w; ++xi) {
            var alphaT = tData[ind + 3] / 255;
            var alphaS = this.data[sind] * opacity;
            tData[ind + 3] = 255 * alphaT * (1.0 - alphaS);
            ind += 4;
            ++sind;
        }
    }
};

/**
 * Draw the rasterizer's contents to the given bitmap with multiply blending.
 * @param {ImageData} targetData The buffer to draw to.
 * @param {Uint8Array|Array.<number>} color Color to use for drawing. Channel
 * values should be 0-255.
 * @param {number} opacity Opacity to use when drawing the rasterization result.
 * Opacity for each individual pixel is its rasterized opacity times this
 * opacity value.
 * @param {number} x Left edge of the area to copy to targetData. Must be an
 * integer.
 * @param {number} y Top edge of the area to copy to targetData. Must be an
 * integer.
 * @param {number} w Width of the targetData buffer and the area to copy there.
 * Must be an integer.
 * @param {number} h Height of the targetData buffer and the area to copy there.
 * Must be an integer.
 */
Rasterizer.prototype.multiply = function(targetData, color, opacity,
                                         x, y, w, h) {
    var tData = targetData.data;
    for (var yi = 0; yi < h; ++yi) {
        var ind = yi * w * 4;
        var sind = x + (y + yi) * this.width;
        for (var xi = 0; xi < w; ++xi) {
            var alphaT = tData[ind + 3] / 255;
            var alphaS = this.data[sind] * opacity;
            var alpha = alphaS + alphaT * (1.0 - alphaS);
            tData[ind] = tData[ind] *
                         (1.0 + alphaS * (color[0] / 255 - 1.0));
            tData[ind + 1] = tData[ind + 1] *
                             (1.0 + alphaS * (color[1] / 255 - 1.0));
            tData[ind + 2] = tData[ind + 2] *
                             (1.0 + alphaS * (color[2] / 255 - 1.0));
            tData[ind + 3] = 255 * alpha;
            ind += 4;
            ++sind;
        }
    }
};

/**
 * Draw the rasterizer's contents to the given bitmap with screen blending.
 * @param {ImageData} targetData The buffer to draw to.
 * @param {Uint8Array|Array.<number>} color Color to use for drawing. Channel
 * values should be 0-255.
 * @param {number} opacity Opacity to use when drawing the rasterization result.
 * Opacity for each individual pixel is its rasterized opacity times this
 * opacity value.
 * @param {number} x Left edge of the area to copy to targetData. Must be an
 * integer.
 * @param {number} y Top edge of the area to copy to targetData. Must be an
 * integer.
 * @param {number} w Width of the targetData buffer and the area to copy there.
 * Must be an integer.
 * @param {number} h Height of the targetData buffer and the area to copy there.
 * Must be an integer.
 */
Rasterizer.prototype.screen = function(targetData, color, opacity, x, y, w, h) {
    var tData = targetData.data;
    for (var yi = 0; yi < h; ++yi) {
        var ind = yi * w * 4;
        var sind = x + (y + yi) * this.width;
        for (var xi = 0; xi < w; ++xi) {
            var alphaT = tData[ind + 3] / 255;
            var alphaS = this.data[sind] * opacity;
            var alpha = alphaS + alphaT * (1.0 - alphaS);
            tData[ind] = alphaS *
                (255 - (1.0 - color[0] / 255) * (255 - tData[ind])) +
                (1.0 - alphaS) * tData[ind];
            tData[ind + 1] = alphaS *
                (255 - (1.0 - color[1] / 255) * (255 - tData[ind + 1])) +
                (1.0 - alphaS) * tData[ind + 1];
            tData[ind + 2] = alphaS *
                (255 - (1.0 - color[2] / 255) * (255 - tData[ind + 2])) +
                (1.0 - alphaS) * tData[ind + 2];
            tData[ind + 3] = 255 * alpha;
            ind += 4;
            ++sind;
        }
    }
};

/**
 * Draw the rasterizer's contents to the given bitmap with overlay blending.
 * @param {ImageData} targetData The buffer to draw to.
 * @param {Uint8Array|Array.<number>} color Color to use for drawing. Channel
 * values should be 0-255.
 * @param {number} opacity Opacity to use when drawing the rasterization result.
 * Opacity for each individual pixel is its rasterized opacity times this
 * opacity value.
 * @param {number} x Left edge of the area to copy to targetData. Must be an
 * integer.
 * @param {number} y Top edge of the area to copy to targetData. Must be an
 * integer.
 * @param {number} w Width of the targetData buffer and the area to copy there.
 * Must be an integer.
 * @param {number} h Height of the targetData buffer and the area to copy there.
 * Must be an integer.
 */
Rasterizer.prototype.overlay = function(targetData, color, opacity, x, y, w, h) {
    var tData = targetData.data;
    for (var yi = 0; yi < h; ++yi) {
        var ind = yi * w * 4;
        var sind = x + (y + yi) * this.width;
        for (var xi = 0; xi < w; ++xi) {
            var alphaT = tData[ind + 3] / 255;
            var alphaS = this.data[sind] * opacity;
            var alpha = alphaS + alphaT * (1.0 - alphaS);
            for (var c = 0; c < 3; c++) {
                tData[ind + c] = mathUtil.mix(tData[ind + c],
                        tData[ind + c] < 128.0 ?
                        (2.0 / 255.0 * tData[ind + c] * color[c]) :
                        (255.0 - 2.0 * (1.0 - color[c] / 255.0) *
                                (255.0 - tData[ind + c])),
                        alphaS);
            }
            tData[ind + 3] = 255 * alpha;
            ind += 4;
            ++sind;
        }
    }
};

/**
 * Draw the rasterizer's contents to the given bitmap. The target bitmap must
 * be opaque i.e. contain only pixels with alpha 255.
 * @param {ImageData} targetData The buffer to draw to.
 * @param {Uint8Array|Array.<number>} color Color to use for drawing. Channel
 * values should be 0-255.
 * @param {number} opacity Opacity to use when drawing the rasterization result.
 * Opacity for each individual pixel is its rasterized opacity times this
 * opacity value.
 * @param {number} x Left edge of the area to copy to targetData. Must be an
 * integer.
 * @param {number} y Top edge of the area to copy to targetData. Must be an
 * integer.
 * @param {number} w Width of the targetData buffer and the area to copy there.
 * Must be an integer.
 * @param {number} h Height of the targetData buffer and the area to copy there.
 * Must be an integer.
 */
Rasterizer.prototype.drawWithColorToOpaque = function(targetData, color,
                                                      opacity, x, y, w, h) {
    var tData = targetData.data;
    for (var yi = 0; yi < h; ++yi) {
        var ind = yi * w * 4;
        var sind = x + (y + yi) * this.width;
        for (var xi = 0; xi < w; ++xi) {
            var alphaS = this.data[sind] * opacity;
            var tMult = 1.0 - alphaS;
            tData[ind] = (tData[ind] * tMult + color[0] * alphaS);
            tData[ind + 1] = (tData[ind + 1] * tMult + color[1] * alphaS);
            tData[ind + 2] = (tData[ind + 2] * tMult + color[2] * alphaS);
            ind += 4;
            ++sind;
        }
    }
};

/**
 * Clear the rasterizer's bitmap to all 0's.
 */
Rasterizer.prototype.clear = function() {
    var br = this.clipRect.getXYWH();
    for (var y = 0; y < br.h; ++y) {
        for (var x = 0; x < br.w; ++x) {
            this.data[br.x + x + (br.y + y) * this.width] = 0;
        }
    }
};

/**
 * Return the pixel at the given coordinates.
 * @param {Vec2} coords The coordinates to query with.
 * @return {number} The pixel value, in the range 0-1.
 */
Rasterizer.prototype.getPixel = function(coords) {
    return this.data[Math.floor(coords.x) + Math.floor(coords.y) * this.width];
};

/**
 * Fill a circle to the rasterizer's bitmap at the given coordinates. Uses the
 * soft and flowAlpha values set using beginCircleLines, and clips the circle to
 * the current clipping rectangle.
 * @param {number} centerX The x coordinate of the center of the circle.
 * @param {number} centerY The y coordinate of the center of the circle.
 * @param {number} radius The radius of the circle.
 */
Rasterizer.prototype.fillCircle = function(centerX, centerY, radius) {
    if (!this.clipRect.mightIntersectCircleRoundedOut(centerX, centerY,
                                             this.drawBoundingRadius(radius))) {
        return;
    }
    var circleRect = Rect.fromCircle(centerX, centerY,
                                     this.drawBoundingRadius(radius));
    circleRect.intersectRectRoundedOut(this.clipRect);
    this.dirtyArea.unionRect(circleRect);
    // integer x and y coordinates that we use here correspond to pixel corners.
    // instead of correcting the x and y by 0.5 on each iteration,
    // compensate by moving the center.
    centerX -= 0.5;
    centerY -= 0.5;
    if (this.soft) {
        this.fillSoftCircleBlending(circleRect, centerX, centerY,
                                    this.drawRadius(radius),
                                    this.drawAlpha(radius));
    } else {
        this.fillCircleBlending(circleRect, centerX, centerY,
                                this.drawRadius(radius),
                                this.drawAlpha(radius));
    }
};

/**
 * Helper to rasterize a solid circle.
 * @param {Rect} boundsRect The rect to rasterize to.
 * @param {number} centerX The x coordinate of the center of the circle.
 * @param {number} centerY The y coordinate of the center of the circle.
 * @param {number} radius The radius of the circle.
 * @param {number} alpha Alpha to draw with.
 * @protected
 */
Rasterizer.prototype.fillCircleBlending = function(boundsRect, centerX, centerY,
                                                   radius, alpha) {
    var rad2 = (radius + 1.0) * (radius + 1.0);
    for (var y = boundsRect.top; y < boundsRect.bottom; ++y) {
        var ind = boundsRect.left + y * this.width;
        var powy = Math.pow(y - centerY, 2);
        for (var x = boundsRect.left; x < boundsRect.right; ++x) {
            var dist2 = Math.pow(x - centerX, 2) + powy;
            if (dist2 < rad2) {
                if (dist2 > (radius - 1.0) * (radius - 1.0)) {
                    // hacky antialias
                    var mult = (radius + 1.0 - Math.sqrt(dist2)) * 0.5;
                    this.data[ind] = alpha * mult + this.data[ind] *
                                     (1.0 - alpha * mult);
                } else {
                    this.data[ind] = alpha + this.data[ind] * (1.0 - alpha);
                }
            }
            ++ind;
        }
    }
};

/**
 * Helper to rasterize a soft circle.
 * @param {Rect} boundsRect The rect to rasterize to.
 * @param {number} centerX The x coordinate of the center of the circle.
 * @param {number} centerY The y coordinate of the center of the circle.
 * @param {number} radius The radius of the circle.
 * @param {number} alpha Alpha to draw with.
 * @protected
 */
Rasterizer.prototype.fillSoftCircleBlending = function(boundsRect, centerX,
                                                       centerY, radius, alpha) {
    var rad2 = (radius + 1.0) * (radius + 1.0);
    for (var y = boundsRect.top; y < boundsRect.bottom; ++y) {
        var ind = boundsRect.left + y * this.width;
        var powy = Math.pow(y - centerY, 2);
        for (var x = boundsRect.left; x < boundsRect.right; ++x) {
            var dist2 = Math.pow(x - centerX, 2) + powy;
            if (dist2 < rad2) {
                var distalpha = (1.0 - Math.sqrt(dist2 / rad2)) * alpha;
                if (dist2 > (radius - 1.0) * (radius - 1.0)) {
                    // hacky antialias
                    distalpha *= (radius + 1.0 - Math.sqrt(dist2)) * 0.5;
                }
                this.data[ind] = distalpha + this.data[ind] * (1.0 - distalpha);
            }
            ++ind;
        }
    }
};

/**
 * Draw a linear gradient from coords1 to coords0. The pixel at coords1 will be
 * set to 1.0, and the pixel at coords0 will be set to 0.0. If the coordinates
 * are the same, does nothing.
 * @param {Vec2} coords1 Coordinates for the 1.0 end of the gradient.
 * @param {Vec2} coords0 Coordinates for the 0.0 end of the gradient.
 */
Rasterizer.prototype.linearGradient = function(coords1, coords0) {
    var br = this.clipRect.getXYWH();
    if (coords1.x === coords0.x) {
        if (coords1.y === coords0.y) {
            return;
        }
        this.dirtyArea.unionRect(this.clipRect);
        // Every horizontal line will be of one color
        var top = Math.min(coords1.y, coords0.y);
        var bottom = Math.max(coords1.y, coords0.y);
        var topFill = (coords0.y < coords1.y) ? 0.0 : 1.0;
        var bottomFill = 1.0 - topFill;
        var y = br.y;
        var ind = y * this.width + br.x;
        var right = ind + br.w;
        while (y + 0.5 <= top && y < br.y + br.h) {
            ind = y * this.width + br.x;
            right = ind + br.w;
            while (ind < right) {
                this.data[ind] = topFill;
                ++ind;
            }
            ++y;
        }
        while (y + 0.5 < bottom && y < br.y + br.h) {
            // Take the gradient color at the pixel center.
            // TODO: Integrate coverage along y instead to anti-alias this.
            // TODO: assert(y + 0.5 > top && y + 0.5 < bottom);
            ind = y * this.width + br.x;
            right = ind + br.w;
            var rowFill = (coords0.y < coords1.y ?
                           (y + 0.5 - top) : (bottom - y - 0.5)) /
                          (bottom - top);
            while (ind < right) {
                this.data[ind] = rowFill;
                ++ind;
            }
            ++y;
        }
        while (y < br.y + br.h) {
            ind = y * this.width + br.x;
            right = ind + br.w;
            while (ind < right) {
                this.data[ind] = bottomFill;
                ++ind;
            }
            ++y;
        }
        return;
    } else {
        this.dirtyArea.unionRect(this.clipRect);
        var lineStartCoords = new Vec2(0, 0);
        var lineEndCoords = new Vec2(0, 0);
        for (var y = br.y; y < br.y + br.h; ++y) {
            // TODO: Again, integrating coverage over the pixel would be nice.
            lineStartCoords.x = 0.5;
            lineStartCoords.y = y + 0.5;
            lineEndCoords.x = this.width - 0.5;
            lineEndCoords.y = y + 0.5;
            lineStartCoords.projectToLine(coords0, coords1);
            lineEndCoords.projectToLine(coords0, coords1);
            var lineStartValue = (lineStartCoords.x - coords0.x) /
                                 (coords1.x - coords0.x);
            var lineEndValue = (lineEndCoords.x - coords0.x) /
                               (coords1.x - coords0.x);
            var x = br.x;
            var ind = y * this.width + x;
            var right = ind + br.w;
            while (ind < right) {
                var mult = (x / this.width);
                var unclamped = mult * lineEndValue +
                                (1.0 - mult) * lineStartValue;
                this.data[ind] = Math.max(0.0, Math.min(1.0, unclamped));
                ++ind;
                ++x;
            }
        }
    }
};


/**
 * 'redGreen' uses red and green channels of the UINT8 texture to store the high
 * and low bits of the alpha value. 'alpha' uses just the alpha channel, so that
 * normal built-in blends can be used.
 * @enum {number}
 */
GLRasterizerFormat = {
    redGreen: 0,
    alpha: 1
};


/**
 * A WebGL rasterizer using two RGB Uint8 buffers as backing for its bitmap.
 * Floating point support in the WebGL implementation is not required.
 * @constructor
 * @param {WebGLRenderingContext} gl The rendering context.
 * @param {Object} glManager The state manager returned by glStateManager() in
 * utilgl.
 * @param {number} width Width of the rasterizer bitmap in pixels.
 * @param {number} height Height of the rasterizer bitmap in pixels.
 */
var GLDoubleBufferedRasterizer = function(gl, glManager, width, height) {
    this.initBaseRasterizer(width, height);
    this.initGLRasterizer(gl, glManager, GLRasterizerFormat.redGreen,
                          GLDoubleBufferedRasterizer.maxCircles, 3);
    // TODO: Move to gl.RG if EXT_texture_RG becomes available in WebGL
    this.tex0 = glUtils.createTexture(gl, width, height, gl.RGB);
    this.tex1 = glUtils.createTexture(gl, width, height, gl.RGB);
    this.tex0Inval = new Rect();
    this.tex1Inval = new Rect();
    this.currentTex = 0;

    if (!GLDoubleBufferedRasterizer.nFillShader) {
        // TODO: assert(!GLDoubleBufferedRasterizer.nSoftShader)
        // assert(!GLDoubleBufferedRasterizer.linearGradientShader)
        GLDoubleBufferedRasterizer.nFillShader = [];
        GLDoubleBufferedRasterizer.nSoftShader = [];
        for (var i = 1; i <= GLDoubleBufferedRasterizer.maxCircles; ++i) {
            GLDoubleBufferedRasterizer.nFillShader.push(
                new RasterizeShader(GLRasterizerFormat.redGreen, false, i,
                                    false,
                                    RasterizeShader.ParameterMode.inUniforms,
                                    true));
            GLDoubleBufferedRasterizer.nSoftShader.push(
                new RasterizeShader(GLRasterizerFormat.redGreen, true, i,
                                    false,
                                    RasterizeShader.ParameterMode.inUniforms,
                                    true));
        }
        GLDoubleBufferedRasterizer.linearGradientShader =
            new GradientShader(GLRasterizerFormat.redGreen, false);
        GLDoubleBufferedRasterizer.verticalGradientShader =
            new GradientShader(GLRasterizerFormat.redGreen, true);
    }

    this.generateShaderPrograms(GLDoubleBufferedRasterizer.nFillShader,
                                GLDoubleBufferedRasterizer.nSoftShader,
                                GLDoubleBufferedRasterizer.linearGradientShader,
                             GLDoubleBufferedRasterizer.verticalGradientShader);

    this.convUniformParameters = new blitShader.ConversionUniformParameters();
    this.conversionProgram = this.glManager.shaderProgram(
        blitShader.convertRedGreenSrc, blitShader.blitVertSrc,
        {'uSrcTex': 'tex2d', 'uColor': '4fv'});
};

/** @const */
GLDoubleBufferedRasterizer.maxCircles = 6;

/**
 * RasterizeShaders for drawing filled circles. Amount of circles is determined
 * at compile-time, nFillShader[i] draws i+1 circles.
 * @protected
 */
GLDoubleBufferedRasterizer.nFillShader = null;
/**
 * RasterizeShaders for drawing soft circles. Amount of circles is determined
 * at compile-time, nSoftShader[i] draws i+1 circles.
 * @protected
 */
 GLDoubleBufferedRasterizer.nSoftShader = null;

GLDoubleBufferedRasterizer.prototype = new BaseRasterizer();

/**
 * @return {number} The GPU memory usage of this rasterizer in bytes.
 */
GLDoubleBufferedRasterizer.prototype.getMemoryBytes = function() {
    return this.width * this.height * 6;
};

/**
 * Initialize the WebGL-based rasterizer.
 * @param {WebGLRenderingContext} gl The rendering context.
 * @param {Object} glManager The state manager returned by glStateManager() in
 * utilgl.
 * @param {GLRasterizerFormat} format Format of the rasterizers texture.
 * @param {number} maxCircles The maximum amount of circles to render in one
 * pass. Must be an integer > 0.
 * @param {number} paramsStride The amount of floating point parameter slots
 * per circle to allocate. In GLDoubleBufferedRasterizer.fillCircle(), first
 * three parameters for each circle are set to x, y, and radius, and the rest is
 * padding, so paramsStride should be at least 3. Must be an integer.
 * @protected
 */
GLDoubleBufferedRasterizer.prototype.initGLRasterizer = function(gl, glManager,
                                             format, maxCircles, paramsStride) {
    this.gl = gl;
    this.glManager = glManager;
    this.format = format;

    this.paramsStride = paramsStride;
    this.maxCircles = maxCircles;

    // 4 bytes per float
    var paramBuffer = new ArrayBuffer(this.maxCircles *
                                      this.paramsStride * 4);
    this.params = new Float32Array(paramBuffer);
    this.circleRect = new Rect();
    this.circleInd = 0;
};

/**
 * Generate shader programs for a WebGL-based rasterizer.
 * @param {Array.<RasterizeShader>} nFillShader Filled circle shaders.
 * @param {Array.<RasterizeShader>} nSoftShader Soft circle shaders.
 * @param {GradientShader} linearGradientShader Linear non-vertical gradient
 * shader.
 * @param {GradientShader} verticalGradientShader Vertical gradient shader.
 * @protected
 */
GLDoubleBufferedRasterizer.prototype.generateShaderPrograms = function(
       nFillShader, nSoftShader, linearGradientShader, verticalGradientShader) {
    this.nFillCircleProgram = [];
    this.nSoftCircleProgram = [];
    this.uniformParameters = [];

    // TODO: assert(nFillShader.length == nSoftShader.length);
    for (i = 0; i < nFillShader.length; ++i) {
        this.nFillCircleProgram.push(
            nFillShader[i].programInstance(this.gl));
        this.nSoftCircleProgram.push(
            nSoftShader[i].programInstance(this.gl));
        // The uniforms are the same for the soft and fill shaders
        this.uniformParameters.push(
            nFillShader[i].uniformParameters(this.width, this.height));
    }
    this.linearGradientProgram = linearGradientShader.programInstance(this.gl);
    this.verticalGradientProgram =
        verticalGradientShader.programInstance(this.gl);
    this.gradientUniformParameters =
        linearGradientShader.uniformParameters(this.width, this.height);
};

/**
 * Clean up any allocated resources. The rasterizer is not usable after this.
 */
GLDoubleBufferedRasterizer.prototype.free = function() {
    this.gl.deleteTexture(this.tex0);
    this.gl.deleteTexture(this.tex1);
    this.tex0 = undefined;
    this.tex1 = undefined;
};

/**
 * Switch between textures.
 * @protected
 */
GLDoubleBufferedRasterizer.prototype.switchTex = function() {
    this.currentTex = 1 - this.currentTex;
};

/**
 * Get the source texture that contains the most up-to-date contents of the
 * rasterizer bitmap.
 * @return {WebGLTexture} The source texture.
 * @protected
 */
GLDoubleBufferedRasterizer.prototype.getTex = function() {
    if (this.currentTex === 0) {
        return this.tex0;
    } else {
        return this.tex1;
    }
};

/**
 * Draw the rasterizer's contents to the current framebuffer.
 * @param {Uint8Array|Array.<number>} color Color to use for drawing. Channel
 * values should be 0-255.
 * @param {number} opacity Opacity to use when drawing the rasterization result.
 * Opacity for each individual pixel is its rasterized opacity times this
 * opacity value.
 * @param {PictureEvent.Mode} mode Blending mode to use for drawing.
 */
GLDoubleBufferedRasterizer.prototype.drawWithColor = function(color, opacity,
                                                              mode) {
    if (mode === PictureEvent.Mode.erase) {
        this.gl.blendFunc(this.gl.ZERO, this.gl.ONE_MINUS_SRC_ALPHA);
    }
    this.convUniformParameters['uSrcTex'] = this.getTex();
    for (var i = 0; i < 3; ++i) {
        this.convUniformParameters['uColor'][i] = color[i] / 255.0;
    }
    this.convUniformParameters['uColor'][3] = opacity;
    this.glManager.drawFullscreenQuad(this.conversionProgram,
                                      this.convUniformParameters);
    if (mode === PictureEvent.Mode.erase) {
        this.gl.blendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);
    }
};

/**
 * Get the target texture for rasterization.
 * @return {WebGLTexture} The target texture.
 * @protected
 */
GLDoubleBufferedRasterizer.prototype.getTargetTex = function() {
    if (this.currentTex === 0) {
        return this.tex1;
    } else {
        return this.tex0;
    }
};

/**
 * Clear the target texture's invalid area after drawing.
 * @protected
 */
GLDoubleBufferedRasterizer.prototype.clearTargetInval = function() {
    if (this.currentTex === 0) {
        this.tex1Inval.makeEmpty();
    } else {
        this.tex0Inval.makeEmpty();
    }
};

/**
 * Clear the rasterizer's bitmap (both textures) to all 0's.
 */
GLDoubleBufferedRasterizer.prototype.clear = function() {
    this.gl.clearColor(0, 0, 0, 0);
    glUtils.updateClip(this.gl, this.clipRect, this.height);
    for (var i = 0; i < 2; ++i) {
        this.glManager.useFboTex(this.getTargetTex());
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        this.clearTargetInval();
        this.switchTex();
    }
};

/**
 * Set circle parameters to a vec uniform.
 * @param {Float32Array} u Array to store the parameters in. First two items are
 * set to the circle center x and y in clip coordinates (range -1 to 1, though
 * values are not clamped to this range) The third item is set to the circle
 * radius in pixels.
 * @param {number} centerX The x coordinate of the circle center in pixels.
 * @param {number} centerY The y coordinate of the circle center in pixels.
 * @param {number} radius The radius of the circle in pixels.
 * @protected
 */
GLDoubleBufferedRasterizer.prototype.setCircleUniformParameters = function(u,
                                                     centerX, centerY, radius) {
    u[0] = centerX / this.width * 2.0 - 1.0;
    u[1] = centerY / this.height * (-2.0) + 1.0;
    u[2] = radius;
};

/**
 * Get rectangular bounds for a draw pass.
 * @param {Rect} invalRect Rectangle containing the things to draw. This is
 * combined with the target texture's invalidated area and clipped by the
 * current clip rect. The function is allowed to mutate this Rect.
 * @return {Rect} The bounds for the draw pass.
 * @protected
 */
GLDoubleBufferedRasterizer.prototype.getDrawRect = function(invalRect) {
    var drawRect = (this.currentTex === 0) ? this.tex1Inval : this.tex0Inval;
    drawRect.unionRect(invalRect);
    drawRect.intersectRectRoundedOut(this.clipRect);
    return drawRect;
};

/**
 * Set the framebuffer, flow alpha and source texture for drawing.
 * @param {Object.<string, *>} uniformParameters Map from uniform names to
 * uniform values to set drawing parameters to.
 * @protected
 */
GLDoubleBufferedRasterizer.prototype.preDraw = function(uniformParameters) {
    this.glManager.useFboTex(this.getTargetTex());
    if (uniformParameters !== null) {
        uniformParameters['uFlowAlpha'] = this.flowAlpha;
        uniformParameters['uSrcTex'] = this.getTex();
    }
};

/**
 * Invalidate the area of the source texture which has now been updated in the
 * target texture, and switch textures.
 * @param {Rect} invalRect The area that has been changed in the target texture.
 * @protected
 */
GLDoubleBufferedRasterizer.prototype.postDraw = function(invalRect) {
    this.clearTargetInval();
    if (this.currentTex === 0) {
        this.tex0Inval.unionRect(invalRect);
    } else {
        this.tex1Inval.unionRect(invalRect);
    }
    this.switchTex();
};

/**
 * Fill a circle to the rasterizer's bitmap at the given coordinates. Uses the
 * soft and flowAlpha values set using beginCircleLines, and clips the circle to
 * the current clipping rectangle. The circle is added to the queue, which is
 * automatically flushed when it's full. Flushing manually should be done at the
 * end of drawing circles.
 * @param {number} centerX The x coordinate of the center of the circle.
 * @param {number} centerY The y coordinate of the center of the circle.
 * @param {number} radius The radius of the circle.
 */
GLDoubleBufferedRasterizer.prototype.fillCircle = function(centerX, centerY,
                                                           radius) {
    this.circleRect.unionCircle(centerX, centerY,
                                this.drawBoundingRadius(radius));
    this.params[this.circleInd * this.paramsStride] = centerX;
    this.params[this.circleInd * this.paramsStride + 1] = centerY;
    this.params[this.circleInd * this.paramsStride + 2] = radius;
    this.circleInd++;
    if (this.circleInd >= this.maxCircles) {
        // TODO: assert(this.circleInd === this.maxCircles);
        this.flushCircles();
    }
};

/**
 * Flush all circle drawing commands that have been given to the bitmap.
 */
GLDoubleBufferedRasterizer.prototype.flushCircles = function() {
    if (this.circleInd === 0) {
        return;
    }
    var drawRect = this.getDrawRect(this.circleRect); // may change circleRect!
    var circleCount = this.circleInd;
    this.preDraw(this.uniformParameters[circleCount - 1]);
    for (var i = 0; i < circleCount; ++i) {
        this.setCircleUniformParameters(
            this.uniformParameters[circleCount - 1]['uCircle' + i],
            this.params[i * 3], this.params[i * 3 + 1], this.params[i * 3 + 2]);
    }
    glUtils.updateClip(this.gl, drawRect, this.height);
    if (this.soft) {
        this.glManager.drawFullscreenQuad(
            this.nSoftCircleProgram[circleCount - 1],
            this.uniformParameters[circleCount - 1]);
    } else {
        this.glManager.drawFullscreenQuad(
            this.nFillCircleProgram[circleCount - 1],
            this.uniformParameters[circleCount - 1]);
    }
    this.dirtyArea.unionRect(drawRect);
    this.postDraw(this.circleRect);
    this.circleRect.makeEmpty();
    this.circleInd = 0;
};

/**
 * Draw a linear gradient from coords1 to coords0. The pixel at coords1 will be
 * set to 1.0, and the pixel at coords0 will be set to 0.0. If the coordinates
 * are the same, does nothing.
 * @param {Vec2} coords1 Coordinates for the 1.0 end of the gradient.
 * @param {Vec2} coords0 Coordinates for the 0.0 end of the gradient.
 */
GLDoubleBufferedRasterizer.prototype.linearGradient = function(coords1,
                                                               coords0) {
    if (coords1.x === coords0.x && coords1.y === coords0.y) {
        return;
    }
    this.dirtyArea.unionRect(this.clipRect);
    this.preDraw(null);
    var drawRect = new Rect(0, this.width, 0, this.height);
    drawRect.intersectRectRoundedOut(this.clipRect);
    glUtils.updateClip(this.gl, drawRect, this.height);
    this.gradientUniformParameters['uCoords0'][0] = coords0.x;
    this.gradientUniformParameters['uCoords0'][1] = this.height - coords0.y;
    this.gradientUniformParameters['uCoords1'][0] = coords1.x;
    this.gradientUniformParameters['uCoords1'][1] = this.height - coords1.y;
    if (coords0.x === coords1.x) {
        this.glManager.drawFullscreenQuad(this.verticalGradientProgram,
                                          this.gradientUniformParameters);
    } else {
        this.glManager.drawFullscreenQuad(this.linearGradientProgram,
                                          this.gradientUniformParameters);
    }
    this.postDraw(drawRect);
};

/**
 * Return the pixel at the given coordinates.
 * @param {Vec2} coords The coordinates to query with.
 * @return {number} The pixel value, in the range 0-1.
 */
GLDoubleBufferedRasterizer.prototype.getPixel = function(coords) {
    this.glManager.useFbo(null);
    this.gl.clearColor(0.0, 0.0, 0.0, 1.0);
    var left = Math.floor(coords.x);
    var top = Math.floor(coords.y);
    glUtils.updateClip(this.gl, new Rect(left, left + 1, top, top + 1),
                       this.height);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.drawWithColor([255, 255, 255], 1.0);
    var pixel = new Uint8Array([0, 0, 0, 0]);
    this.gl.readPixels(left, this.height - 1 - top, 1, 1, this.gl.RGBA,
                       this.gl.UNSIGNED_BYTE, pixel);
    return pixel[0] / 255.0;
};


/**
 * A WebGL rasterizer using one RGBA Float32 buffer as backing for its bitmap.
 * Floating point support in the WebGL implementation is required.
 * @constructor
 * @param {WebGLRenderingContext} gl The rendering context.
 * @param {Object} glManager The state manager returned by glStateManager() in
 * utilgl.
 * @param {number} width Width of the rasterizer bitmap in pixels.
 * @param {number} height Height of the rasterizer bitmap in pixels.
 */
var GLFloatRasterizer = function(gl, glManager, width, height) {
    var i;
    this.initBaseRasterizer(width, height);
    this.initGLRasterizer(gl, glManager, GLRasterizerFormat.alpha,
                          GLFloatRasterizer.maxCircles, 3);
    this.tex = glUtils.createTexture(gl, width, height, this.gl.RGBA,
                                     this.gl.FLOAT);

    if (!GLFloatRasterizer.nFillShader) {
        // TODO: assert(!GLFloatRasterizer.nSoftShader)
        GLFloatRasterizer.nFillShader = [];
        GLFloatRasterizer.nSoftShader = [];
        for (i = 1; i <= GLFloatRasterizer.maxCircles; ++i) {
            GLFloatRasterizer.nFillShader.push(
                new RasterizeShader(GLRasterizerFormat.alpha, false, i, false,
                                    RasterizeShader.ParameterMode.inUniforms,
                                    true));
            GLFloatRasterizer.nSoftShader.push(
                new RasterizeShader(GLRasterizerFormat.alpha, true, i, false,
                                    RasterizeShader.ParameterMode.inUniforms,
                                    true));
        }
    }
    if (!GLFloatRasterizer.linearGradientShader) {
        // TODO: assert(!GLFloatRasterizer.verticalGradientShader);
        GLFloatRasterizer.linearGradientShader =
            new GradientShader(GLRasterizerFormat.alpha, false);
        GLFloatRasterizer.verticalGradientShader =
            new GradientShader(GLRasterizerFormat.alpha, true);
    }

    this.generateShaderPrograms(GLFloatRasterizer.nFillShader,
                                GLFloatRasterizer.nSoftShader,
                                GLFloatRasterizer.linearGradientShader,
                                GLFloatRasterizer.verticalGradientShader);

    this.convUniformParameters = new blitShader.ConversionUniformParameters();
    this.conversionProgram = this.glManager.shaderProgram(
        blitShader.convertSimpleSrc, blitShader.blitVertSrc,
        {'uSrcTex': 'tex2d', 'uColor': '4fv'});
};

/** @const */
GLFloatRasterizer.maxCircles = 6;

/**
 * RasterizeShaders for drawing filled circles. Amount of circles is determined
 * at compile-time, nFillShader[i] draws i+1 circles.
 * @protected
 */
GLFloatRasterizer.nFillShader = null;
/**
 * RasterizeShaders for drawing soft circles. Amount of circles is determined
 * at compile-time, nSoftShader[i] draws i+1 circles.
 * @protected
 */
GLFloatRasterizer.nSoftShader = null;

GLFloatRasterizer.prototype = new BaseRasterizer();

/**
 * @return {number} The GPU memory usage of this rasterizer in bytes.
 */
GLFloatRasterizer.prototype.getMemoryBytes = function() {
    return this.width * this.height * 16;
};

// TODO: Is this use of inheritDoc correct?
/** @inheritDoc */
GLFloatRasterizer.prototype.initGLRasterizer =
    GLDoubleBufferedRasterizer.prototype.initGLRasterizer;

/** @inheritDoc */
GLFloatRasterizer.prototype.generateShaderPrograms =
    GLDoubleBufferedRasterizer.prototype.generateShaderPrograms;

/**
 * Clean up any allocated resources. The rasterizer is not usable after this.
 */
GLFloatRasterizer.prototype.free = function() {
    this.gl.deleteTexture(this.tex);
    this.tex = undefined;
};

/**
 * Get the source texture that contains the most up-to-date contents of the
 * rasterizer bitmap.
 * @return {WebGLTexture} The source texture.
 */
GLFloatRasterizer.prototype.getTex = function() {
    return this.tex;
};

/**
 * Get rectangular bounds for a draw pass.
 * @param {Rect} invalRect Rectangle containing the things to draw. This is
 * combined with the target texture's invalidated area and clipped by the
 * current clip rect. The function is allowed to mutate this Rect.
 * @return {Rect} The bounds for the draw pass.
 */
GLFloatRasterizer.prototype.getDrawRect = function(invalRect) {
    invalRect.intersectRectRoundedOut(this.clipRect);
    return invalRect;
};

/**
 * Set the framebuffer and flow alpha for drawing.
 * @param {Object.<string, *>} uniformParameters Map from uniform names to
 * uniform values to set drawing parameters to.
 * @protected
 */
GLFloatRasterizer.prototype.preDraw = function(uniformParameters) {
    this.glManager.useFboTex(this.tex);
    if (uniformParameters !== null) {
        uniformParameters['uFlowAlpha'] = this.flowAlpha;
    }
};

/**
 * Post-draw callback required for using GLDoubleBufferedRasterizer's
 * flushCircles.
 * @param {Rect} invalRect The area that has been changed in the target texture.
 * @protected
 */
GLFloatRasterizer.prototype.postDraw = function(invalRect) {
};

/** @inheritDoc */
GLFloatRasterizer.prototype.drawWithColor =
    GLDoubleBufferedRasterizer.prototype.drawWithColor;

/**
 * Clear the rasterizer's bitmap to all 0's.
 */
GLFloatRasterizer.prototype.clear = function() {
    this.gl.clearColor(0, 0, 0, 0);
    glUtils.updateClip(this.gl, this.clipRect, this.height);
    this.glManager.useFboTex(this.tex);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
};

/** @inheritDoc */
GLFloatRasterizer.prototype.setCircleUniformParameters =
    GLDoubleBufferedRasterizer.prototype.setCircleUniformParameters;

/** @inheritDoc */
GLFloatRasterizer.prototype.fillCircle =
    GLDoubleBufferedRasterizer.prototype.fillCircle;

/** @inheritDoc */
GLFloatRasterizer.prototype.flushCircles =
    GLDoubleBufferedRasterizer.prototype.flushCircles;

/** @inheritDoc */
GLFloatRasterizer.prototype.linearGradient =
    GLDoubleBufferedRasterizer.prototype.linearGradient;

/** @inheritDoc */
GLFloatRasterizer.prototype.getPixel =
    GLDoubleBufferedRasterizer.prototype.getPixel;


/**
 * A WebGL rasterizer using one RGBA Float32 buffer as backing for its bitmap.
 * Uses a Float32 texture to pass parameters to its shaders instead of uniforms,
 * and determines the amount of circles at shader run time. Floating point
 * support in the WebGL implementation is required.
 * @constructor
 * @param {WebGLRenderingContext} gl The rendering context.
 * @param {Object} glManager The state manager returned by glStateManager() in
 * utilgl.
 * @param {number} width Width of the rasterizer bitmap in pixels.
 * @param {number} height Height of the rasterizer bitmap in pixels.
 */
var GLFloatTexDataRasterizer = function(gl, glManager, width, height) {
    this.initBaseRasterizer(width, height);
    // TODO: Possible to use RGB texture and paramsStride 3?
    // Not useful if more parameters are added.
    this.initGLRasterizer(gl, glManager, GLRasterizerFormat.alpha,
                          GLFloatTexDataRasterizer.maxCircles, 4);
    this.tex = glUtils.createTexture(gl, width, height, this.gl.RGBA,
                                     this.gl.FLOAT);

    this.parameterTex = glUtils.createTexture(gl, this.maxCircles, 1,
                                              this.gl.RGBA, this.gl.FLOAT);

    if (!GLFloatTexDataRasterizer.fillShader) {
        GLFloatTexDataRasterizer.fillShader =
            new RasterizeShader(GLRasterizerFormat.alpha, false,
                                GLFloatTexDataRasterizer.maxCircles, true,
                                RasterizeShader.ParameterMode.inTex, false);
        GLFloatTexDataRasterizer.softShader =
            new RasterizeShader(GLRasterizerFormat.alpha, true,
                                GLFloatTexDataRasterizer.maxCircles, true,
                                RasterizeShader.ParameterMode.inTex, false);
    }
    if (!GLFloatRasterizer.linearGradientShader) {
        // TODO: assert(!GLFloatRasterizer.verticalGradientShader);
        GLFloatRasterizer.linearGradientShader =
            new GradientShader(GLRasterizerFormat.alpha, false);
        GLFloatRasterizer.verticalGradientShader =
            new GradientShader(GLRasterizerFormat.alpha, true);
    }
    this.fillCircleProgram =
        GLFloatTexDataRasterizer.fillShader.programInstance(this.gl);
    this.softCircleProgram =
        GLFloatTexDataRasterizer.softShader.programInstance(this.gl);
    // The uniforms are the same for the soft and fill shaders
    this.uniformParameters =
        GLFloatTexDataRasterizer.fillShader.uniformParameters(width, height);
    this.uniformParameters['uCircleParameters'] = this.parameterTex;

    this.linearGradientProgram =
        GLFloatRasterizer.linearGradientShader.programInstance(this.gl);
    this.verticalGradientProgram =
        GLFloatRasterizer.verticalGradientShader.programInstance(this.gl);
    this.gradientUniformParameters =
        GLFloatRasterizer.linearGradientShader.uniformParameters(this.width,
                                                                 this.height);

    this.convUniformParameters = new blitShader.ConversionUniformParameters();
    this.conversionProgram =
        this.glManager.shaderProgram(blitShader.convertSimpleSrc,
                                     blitShader.blitVertSrc,
                                     {'uSrcTex': 'tex2d', 'uColor': '4fv'});
};

/** @const */
GLFloatTexDataRasterizer.maxCircles = 32;

GLFloatTexDataRasterizer.prototype = new BaseRasterizer();

/**
 * @return {number} The GPU memory usage of this rasterizer in bytes.
 */
GLFloatTexDataRasterizer.prototype.getMemoryBytes = function() {
    return this.width * this.height * 16;
};

/** @inheritDoc */
GLFloatTexDataRasterizer.prototype.initGLRasterizer =
    GLFloatRasterizer.prototype.initGLRasterizer;

/** @inheritDoc */
GLFloatTexDataRasterizer.prototype.free = GLFloatRasterizer.prototype.free;

/** @inheritDoc */
GLFloatTexDataRasterizer.prototype.drawWithColor =
    GLFloatRasterizer.prototype.drawWithColor;

/** @inheritDoc */
GLFloatTexDataRasterizer.prototype.getTex = GLFloatRasterizer.prototype.getTex;

/** @inheritDoc */
GLFloatTexDataRasterizer.prototype.clear = GLFloatRasterizer.prototype.clear;

/** @inheritDoc */
GLFloatTexDataRasterizer.prototype.fillCircle =
    GLFloatRasterizer.prototype.fillCircle;

/** @inheritDoc */
GLFloatTexDataRasterizer.prototype.preDraw =
    GLFloatRasterizer.prototype.preDraw;

/** @inheritDoc */
GLFloatTexDataRasterizer.prototype.postDraw =
    GLFloatRasterizer.prototype.postDraw;

/** @inheritDoc */
GLFloatTexDataRasterizer.prototype.linearGradient =
    GLFloatRasterizer.prototype.linearGradient;

/**
 * Flush all circle drawing commands that have been given to the bitmap.
 */
GLFloatTexDataRasterizer.prototype.flushCircles = function() {
    if (this.circleInd === 0) {
        return;
    }
    this.glManager.useFboTex(this.tex);
    this.uniformParameters['uCircleCount'] = this.circleInd;
    this.uniformParameters['uFlowAlpha'] = this.flowAlpha;
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.parameterTex);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.maxCircles, 1,
                       0, this.gl.RGBA, this.gl.FLOAT, this.params);
    this.circleRect.intersectRectRoundedOut(this.clipRect);
    glUtils.updateClip(this.gl, this.circleRect, this.height);
    if (this.soft) {
        this.glManager.drawFullscreenQuad(this.softCircleProgram,
                                          this.uniformParameters);
    } else {
        this.glManager.drawFullscreenQuad(this.fillCircleProgram,
                                          this.uniformParameters);
    }
    this.dirtyArea.unionRect(this.circleRect);
    this.circleRect.makeEmpty();
    this.circleInd = 0;
};

/** @inheritDoc */
GLFloatTexDataRasterizer.prototype.getPixel =
    GLFloatRasterizer.prototype.getPixel;

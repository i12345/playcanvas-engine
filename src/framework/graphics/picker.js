import { Color } from '../../core/math/color.js';
import { Vec2 } from '../../core/math/vec2.js';

import { ADDRESS_CLAMP_TO_EDGE, FILTER_NEAREST, PIXELFORMAT_RGBA8 } from '../../platform/graphics/constants.js';
import { GraphicsDevice } from '../../platform/graphics/graphics-device.js';
import { RenderTarget } from '../../platform/graphics/render-target.js';
import { Texture } from '../../platform/graphics/texture.js';

import { Camera } from '../../scene/camera.js';
import { Layer } from '../../scene/layer.js';

import { getApplication } from '../globals.js';
import { Debug } from '../../core/debug.js';
import { RenderPassPicker } from './render-pass-picker.js';

const tempSet = new Set();

/**
 * Picker object used to select mesh instances from screen coordinates.
 *
 * @property {number} width Width of the pick buffer in pixels (read-only).
 * @property {number} height Height of the pick buffer in pixels (read-only).
 * @property {RenderTarget} renderTarget The render target used by the picker internally
 * (read-only).
 *
 * @category Graphics
 */
class Picker {
    // internal render target
    renderTarget = null;

    // mapping table from ids to meshInstances
    mapping = new Map();

    /**
     * Create a new Picker instance.
     *
     * @param {import('../app-base.js').AppBase} app - The application managing this picker
     * instance.
     * @param {number} width - The width of the pick buffer in pixels.
     * @param {number} height - The height of the pick buffer in pixels.
     */
    constructor(app, width, height) {
        if (app instanceof GraphicsDevice) {
            app = getApplication();
            Debug.deprecated('pc.Picker now takes pc.AppBase as first argument. Passing pc.GraphicsDevice is deprecated.');
        }

        // Note: The only reason this class needs the app is to access the renderer. Ideally we remove this dependency and move
        // the Picker from framework to the scene level, or even the extras.
        this.renderer = app.renderer;
        this.device = app.graphicsDevice;

        this.renderPass = new RenderPassPicker(this.device, app.renderer);

        this.width = 0;
        this.height = 0;
        this.resize(width, height);
    }

    /**
     * Return the list of mesh instances selected by the specified rectangle in the previously
     * prepared pick buffer.The rectangle using top-left coordinate system.
     *
     * @param {number} x - The left edge of the rectangle.
     * @param {number} y - The top edge of the rectangle.
     * @param {number} [width=1] - The width of the rectangle.
     * @param {number} [height=1] - The height of the rectangle.
     * @returns {import('../../scene/mesh-instance.js').MeshInstance[]} An array of mesh instances
     * that are in the selection.
     * @example
     * // Get the selection at the point (10,20)
     * const selection = picker.getSelection(10, 20);
     * @example
     * // Get all models in rectangle with corners at (10,20) and (20,40)
     * const selection = picker.getSelection(10, 20, 10, 20);
     */
    getSelection(x, y, width, height) {
        const device = this.device;

        if (typeof x === 'object') {
            Debug.deprecated(`Picker.getSelection:param 'rect' is deprecated, use 'x, y, width, height' instead.`);

            const rect = x;
            x = rect.x;
            y = rect.y;
            width = rect.width;
            height = rect.height;
        } else {
            y = this.renderTarget.height - (y + (height || 1));
        }

        // make sure we have nice numbers to work with
        x = Math.floor(x);
        y = Math.floor(y);
        width = Math.floor(Math.max(width || 1, 1));
        height = Math.floor(Math.max(height || 1, 1));

        // read pixels from the render target
        device.setRenderTarget(this.renderTarget);
        device.updateBegin();

        const pixels = new Uint8Array(4 * width * height);
        device.readPixels(x, y, width, height, pixels);

        device.updateEnd();

        const mapping = this.mapping;
        for (let i = 0; i < width * height; i++) {
            const r = pixels[4 * i + 0];
            const g = pixels[4 * i + 1];
            const b = pixels[4 * i + 2];
            const a = pixels[4 * i + 3];
            const index = a << 24 | r << 16 | g << 8 | b;

            // White is 'no selection'
            if (index !== -1) {
                tempSet.add(mapping.get(index));
            }
        }

        // return the content of the set as an array
        const selection = [];
        tempSet.forEach(meshInstance => selection.push(meshInstance));
        tempSet.clear();

        return selection;
    }

    /**
     * Return a pixel array of mesh instances selected by the specified
     * rectangle in the previously prepared pick buffer.The rectangle using
     * top-left coordinate system.
     *
     * @param {number} x - The left edge of the rectangle.
     * @param {number} y - The top edge of the rectangle.
     * @param {number} [width=1] - The width of the rectangle.
     * @param {number} [height=1] - The height of the rectangle.
     * @param {import('../../scene/mesh-instance.js').MeshInstance[]} [meshInstances] -
     * The array to fill. This array will be resized to have length = (width * height)
     * @returns {import('../../scene/mesh-instance.js').MeshInstance[]} A pixel
     * array of mesh instances that are in the selection.
     * @example
     * // Get all models in rectangle with corners at (10,20) and (20,40)
     * // Then finds the mesh instance at pixel (0, 3)
     * var selection = picker.readSelection(10, 20, 10, 20);
     * var meshInstance = selection[0][3]
     */
    readSelection(x, y, width, height, meshInstances = new Array(width * height)) {
        const device = this.device;

        y = this.renderTarget.height - (y + height);

        // make sure we have nice numbers to work with
        x = Math.floor(x);
        y = Math.floor(y);
        width = Math.floor(Math.max(width, 1));
        height = Math.floor(Math.max(height, 1));

        if (meshInstances.length !== width * height)
            meshInstances.length = width * height;

        // backup active render target
        const origRenderTarget = device.renderTarget;

        DebugGraphics.pushGpuMarker(device, 'PICKER');

        // Ready the device for rendering to the pick buffer
        device.setRenderTarget(this.renderTarget);
        device.updateBegin();

        const pixels = new Uint8Array(4 * width * height);
        device.readPixels(x, y, width, height, pixels);

        device.updateEnd();

        // Restore render target
        device.setRenderTarget(origRenderTarget);

        DebugGraphics.popGpuMarker(device);

        const mapping = this.mapping;
        for (let i = 0; i < width * height; i++) {
            const r = pixels[4 * i + 0];
            const g = pixels[4 * i + 1];
            const b = pixels[4 * i + 2];
            const index = r << 16 | g << 8 | b;

            // White is 'no selection'
            meshInstances[i] = (index !== 0xffffff) ? mapping[index] : undefined;
        }

        return meshInstances;
    }

    allocateRenderTarget() {

        const colorBuffer = new Texture(this.device, {
            format: PIXELFORMAT_RGBA8,
            width: this.width,
            height: this.height,
            mipmaps: false,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            name: 'pick'
        });

        this.renderTarget = new RenderTarget({
            colorBuffer: colorBuffer,
            depth: true
        });
    }

    releaseRenderTarget() {
        if (this.renderTarget) {
            this.renderTarget.destroyTextureBuffers();
            this.renderTarget.destroy();
            this.renderTarget = null;
        }
    }

    /**
     * Primes the pick buffer with a rendering of the specified models from the point of view of
     * the supplied camera. Once the pick buffer has been prepared, {@link Picker#getSelection} can
     * be called multiple times on the same picker object. Therefore, if the models or camera do
     * not change in any way, {@link Picker#prepare} does not need to be called again.
     *
     * @param {import('../components/camera/component.js').CameraComponent} camera - The camera
     * component used to render the scene.
     * @param {import('../../scene/scene.js').Scene} scene - The scene containing the pickable mesh
     * instances.
     * @param {Layer[]} [layers] - Layers from which objects will be picked. If not supplied, all layers of the specified camera will be used.
     */
    prepare(camera, scene, layers) {

        // handle deprecated arguments
        if (camera instanceof Camera) {
            Debug.deprecated('pc.Picker#prepare now takes pc.CameraComponent as first argument. Passing pc.Camera is deprecated.');

            // Get the camera component
            camera = camera.node.camera;
        }

        if (layers instanceof Layer) {
            layers = [layers];
        }

        // make the render target the right size
        if (!this.renderTarget || (this.width !== this.renderTarget.width || this.height !== this.renderTarget.height)) {
            this.releaseRenderTarget();
            this.allocateRenderTarget();
        }

        // clear registered meshes mapping
        this.mapping.clear();

        const renderPass = this.renderPass;
        renderPass.init(this.renderTarget);

        // set up clears
        renderPass.colorOps.clearValue = Color.WHITE;
        renderPass.colorOps.clear = true;
        renderPass.depthStencilOps.clearDepth = true;

        // render the pass to update the render target
        renderPass.update(camera, scene, layers, this.mapping);
        renderPass.render();
    }

    /**
     * Sets the resolution of the pick buffer. The pick buffer resolution does not need to match
     * the resolution of the corresponding frame buffer use for general rendering of the 3D scene.
     * However, the lower the resolution of the pick buffer, the less accurate the selection
     * results returned by {@link Picker#getSelection}. On the other hand, smaller pick buffers
     * will yield greater performance, so there is a trade off.
     *
     * @param {number} width - The width of the pick buffer in pixels.
     * @param {number} height - The height of the pick buffer in pixels.
     */
    resize(width, height) {
        this.width = Math.floor(width);
        this.height = Math.floor(height);
    }
}

class PickerManaged {
    /**
     * @param {import('../app-base.js').AppBase} app - The application managing
     * this picker instance.
     */
    app;

    /**
     * @param {import('../components/camera/component.js').CameraComponent} camera - The camera
     * component used to render the scene.
     */
    camera;

    /**
     * @param {import('../../scene/scene.js').Scene} scene - The scene containing the pickable mesh
     * instances.
     */
    scene;

    /**
     * @param {Layer[]|undefined} layers - Layers from which objects will be picked. If not supplied, all layers of the specified camera will be used.
     */
    layers;

    /**
     * @type {Vec2|undefined} The size of the pick buffer in pixels.
     * If undefined, it will defaults to the size of {@link app.graphicsDevice}
     */
    size;

    /**
     * Create a new Picker instance.
     *
     * @param {import('../app-base.js').AppBase} app - The application managing this picker
     * instance.
     * @param {Vec2|undefined} size - The size of the pick buffer in pixels.
     * If undefined, it will defaults to the size of {@link app.graphicsDevice}
     * @param {import('../components/camera/component.js').CameraComponent} camera - The camera
     * component used to render the scene.
     * @param {import('../../scene/scene.js').Scene} scene - The scene containing the pickable mesh
     * instances.
     * @param {Layer[]|undefined} [layers] - Layers from which objects will be picked. If not supplied, all layers of the specified camera will be used.
     */
    constructor(app, size, camera, scene, layers) {
        this.app = app;
        this.camera = camera;
        this.scene = scene;
        this.layers = layers;
        this.size = size;

        const realSize = this.realSize(app);
        /** @private */
        this.picker = new Picker(app, realSize.x, realSize.y);
    }

    /**
     * Primes the pick buffer with a rendering of the specified models from the point of view of
     * the supplied camera. Once the pick buffer has been prepared, {@link Picker#getSelection} can
     * be called multiple times on the same picker object. Therefore, if the models or camera do
     * not change in any way, {@link Picker#prepare} does not need to be called again.
     */
    prepare() {
        const realSize = this.realSize(this.app);
        if (realSize.x !== this.picker.width ||
            realSize.y !== this.picker.height)
            this.picker.resize(realSize.x, realSize.y);

        this.picker.prepare(this.camera, this.scene, this.layers);
    }

    /**
     * Return the list of mesh instances selected by the specified rectangle in the previously
     * prepared pick buffer.The rectangle using top-left coordinate system.
     *
     * @param {Vec2} p - The top left point of the rectangle.
     * @param {Vec2} [size=Vec2.ONE] - The size of the rectangle.
     * @returns {import('../../scene/mesh-instance.js').MeshInstance[]} An array of mesh instances
     * that are in the selection.
     * @example
     * // Get the selection at the point (10,20)
     * var selection = picker.getSelection(10, 20);
     * @example
     * // Get all models in rectangle with corners at (10,20) and (20,40)
     * var selection = picker.getSelection(10, 20, 10, 20);
     */
    getSelection(p, size) {
        return this.picker.getSelection(p.x, p.y, size?.x, size?.y);
    }

    /**
     * Return a pixel array of mesh instances selected by the specified
     * rectangle in the previously prepared pick buffer.The rectangle using
     * top-left coordinate system.
     *
     * @param {Vec2} p - The top left point of the rectangle.
     * @param {Vec2} [size=Vec2.ONE] - The size of the rectangle.
     * @param {import('../../scene/mesh-instance.js').MeshInstance[]} [meshInstances] -
     * The array to fill. This array will be resized to have length = (width * height)
     * @returns {import('../../scene/mesh-instance.js').MeshInstance[]} A pixel
     * array of mesh instances that are in the selection.
     * @example
     * // Get all models in rectangle with corners at (10,20) and (20,40)
     * // Then finds the mesh instance at pixel (0, 3)
     * var selection = picker.readSelection(10, 20, 10, 20);
     * var meshInstance = selection[0][3]
     */
    readSelection(p, size, meshInstances) {
        return this.picker.readSelection(p.x, p.y, size?.x, size?.y, meshInstances);
    }

    destroy() {
        this.picker.releaseRenderTarget();
    }

    /**
     * Calculates the real size to use for the internal picker.
     *
     * @param {import('../app-base.js').AppBase} app - The application managing this picker
     * instance.
     * @returns {Vec2|undefined} the real size to use for the internal picker.
     * @private
     */
    realSize(app) {
        return this.size ?? new Vec2(app.graphicsDevice.width, app.graphicsDevice.height);
    }
}

export { Picker, PickerManaged };

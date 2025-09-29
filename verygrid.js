class VeryGrid {
    constructor(config) {
        this.canvas = document.getElementById('gpu-canvas');
        this.textCanvas = document.getElementById('text-canvas');
        this.textCtx = this.textCanvas.getContext('2d');

        // Grid configuration
        this.totalRows = config['rows'] || 1000;
        this.totalCols = config['cols'] || 1000;
        this.cellWidth = config['cellWidth'] || 80;
        this.cellHeight = config['cellHeight'] || 24;
        this.dataSource = config['dataSource'] || null;
        this.updateMs = config['updateMs'] || 200;

        this.cellCount = this.totalRows * this.totalCols;

        if (this.dataSource === null) {
            alert("No datasource passed, grid won't do anything.");
            return;
        }

        this.onChanged = config['onChanged'] || null;

        // state
        this.scrollX = 0;
        this.scrollY = 0;
        this.selectedRow = -1;
        this.selectedCol = -1;
        this.isEditing = false;
        this.editor = null;
        this.selectionOverlay = null;
        this.frameCount = 0;
        this.lastFpsTime = performance.now();

        this.cellData = new Float32Array(this.cellCount);
        this.cellColors = new Uint32Array(this.cellCount);

        this.initializeCellData();
        this.setupEventListeners();
        this.init();

        console.log("VeryGrid started, press option/alt for stats");
    }

    async init() {
        if (!navigator.gpu) {
            alert("Doesn't look like WebGPU is supported. Try another browser.")
            return;
        }

        try {
            this.adapter = await navigator.gpu.requestAdapter();
            if (!this.adapter) {
                alert('Unable to setup a GPU adapter.');
                return;
            }

            this.device = await this.adapter.requestDevice();

            this.context = this.canvas.getContext('webgpu');
            this.format = navigator.gpu.getPreferredCanvasFormat();

            this.context.configure({
                device: this.device,
                format: this.format,
                alphaMode: 'premultiplied'
            });

            await this.setupPipeline();
            this.startRenderLoop();
            this.startUpdateLoop();

        } catch (error) {
            alert(`Failed to start: ${error.message}`);
        }
    }

    async setupPipeline() {
        const shaderCode = `
            struct Uniforms {
                scrollX: f32,
                scrollY: f32,
                viewportWidth: f32,
                viewportHeight: f32,
                cellWidth: f32,
                cellHeight: f32,
                totalRows: f32,
                totalCols: f32,
            };
            
            @group(0) @binding(0) var<uniform> uniforms: Uniforms;
            @group(0) @binding(1) var<storage, read> cellData: array<f32>;
            @group(0) @binding(2) var<storage, read> cellColors: array<u32>;
            
            struct VertexOutput {
                @builtin(position) position: vec4f,
                @location(0) color: vec4f,
                @location(1) value: f32,
                @location(2) cellPos: vec2f,
            };
            
            @vertex
            fn vs_main(
                @builtin(vertex_index) vertexIndex: u32,
                @builtin(instance_index) instanceIndex: u32
            ) -> VertexOutput {
                var output: VertexOutput;
                
                // find grid pos
                let visibleCols = u32(ceil(uniforms.viewportWidth / uniforms.cellWidth)) + 1;
                let startCol = u32(floor(uniforms.scrollX / uniforms.cellWidth));
                let startRow = u32(floor(uniforms.scrollY / uniforms.cellHeight));
                
                let localCol = instanceIndex % visibleCols;
                let localRow = instanceIndex / visibleCols;
                
                let col = startCol + localCol;
                let row = startRow + localRow;
                
                if (col >= u32(uniforms.totalCols) || row >= u32(uniforms.totalRows)) {
                    output.position = vec4f(0.0, 0.0, 0.0, 0.0);
                    return output;
                }
                
                // scroll state/position of cell
                let cellX = f32(col) * uniforms.cellWidth - uniforms.scrollX;
                let cellY = f32(row) * uniforms.cellHeight - uniforms.scrollY;
                
                // Quad vertices (0=TL, 1=TR, 2=BL, 3=BR)
                var pos: vec2f;
                if (vertexIndex == 0u) { pos = vec2f(cellX, cellY); }
                else if (vertexIndex == 1u) { pos = vec2f(cellX + uniforms.cellWidth, cellY); }
                else if (vertexIndex == 2u) { pos = vec2f(cellX, cellY + uniforms.cellHeight); }
                else { pos = vec2f(cellX + uniforms.cellWidth, cellY + uniforms.cellHeight); }
                
                // Convert to NDC (-1 to 1)
                let ndcX = (pos.x / uniforms.viewportWidth) * 2.0 - 1.0;
                let ndcY = -((pos.y / uniforms.viewportHeight) * 2.0 - 1.0);
                
                output.position = vec4f(ndcX, ndcY, 0.0, 1.0);
                
                // cell data and colour
                let dataIndex = row * u32(uniforms.totalCols) + col;
                output.value = cellData[dataIndex];
                
                let colorU32 = cellColors[dataIndex];
                let r = f32((colorU32 >> 16u) & 0xFFu) / 255.0;
                let g = f32((colorU32 >> 8u) & 0xFFu) / 255.0;
                let b = f32(colorU32 & 0xFFu) / 255.0;
                output.color = vec4f(r, g, b, 0.15);
                
                output.cellPos = vec2f(f32(vertexIndex % 2u), f32(vertexIndex / 2u));
                
                return output;
            }
            
            @fragment
            fn fs_main(input: VertexOutput) -> @location(0) vec4f {
                // graw lines
                if (input.cellPos.x < 0.02 || input.cellPos.y < 0.02) {
                    return vec4f(0.2, 0.2, 0.2, 1.0);
                }
                
                // use colour from state
                return input.color;
            }
        `;

        const shaderModule = this.device.createShaderModule({
            code: shaderCode
        });

        this.uniformBuffer = this.device.createBuffer({
            size: 8 * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this.cellDataBuffer = this.device.createBuffer({
            size: this.cellData.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });

        this.cellColorBuffer = this.device.createBuffer({
            size: this.cellColors.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });

        this.device.queue.writeBuffer(this.cellDataBuffer, 0, this.cellData);
        this.device.queue.writeBuffer(this.cellColorBuffer, 0, this.cellColors);

        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }
            ]
        });

        this.bindGroup = this.device.createBindGroup({
            layout: bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: { buffer: this.cellDataBuffer } },
                { binding: 2, resource: { buffer: this.cellColorBuffer } }
            ]
        });

        this.pipeline = this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [bindGroupLayout]
            }),
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main'
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{
                    format: this.format,
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha'
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha'
                        }
                    }
                }]
            },
            primitive: {
                topology: 'triangle-strip'
            }
        });
    }

    initializeCellData() {
        for (let i = 0; i < this.cellData.length; i++) {
            this.cellData[i] = 100 + (Math.random() - 0.5) * 200;
            // breach threshold selects red/green
            this.cellColors[i] = Math.random() > 0.5 ? 0xFF00AA00 : 0xFFAA0000;
        }
    }

    uploadGPU() {
        this.device.queue.writeBuffer(this.cellDataBuffer, 0, this.cellData);
        this.device.queue.writeBuffer(this.cellColorBuffer, 0, this.cellColors);
    }

    // gets called every 200ms
    updateCellData() {
        if (!this.dataSource) return;
        this.dataSource(this);
        this.uploadGPU();
    }

    render() {
        if (!this.device || !this.pipeline) return;

        const rect = this.canvas.getBoundingClientRect();
        this.canvas.width = rect.width * devicePixelRatio;
        this.canvas.height = rect.height * devicePixelRatio;

        this.textCanvas.width = rect.width * devicePixelRatio;
        this.textCanvas.height = rect.height * devicePixelRatio;
        this.textCanvas.style.width = rect.width + 'px';
        this.textCanvas.style.height = rect.height + 'px';
        this.textCtx.scale(devicePixelRatio, devicePixelRatio);
        this.textCtx.font = '12px Courier New';
        this.textCtx.textBaseline = 'middle';

        const viewportWidth = rect.width;
        const viewportHeight = rect.height;

        const uniformData = new Float32Array([
            this.scrollX,
            this.scrollY,
            viewportWidth,
            viewportHeight,
            this.cellWidth,
            this.cellHeight,
            this.totalRows,
            this.totalCols
        ]);

        this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

        // determine visible cells
        const startCol = Math.floor(this.scrollX / this.cellWidth);
        const endCol = Math.min(this.totalCols, Math.ceil((this.scrollX + viewportWidth) / this.cellWidth));
        const startRow = Math.floor(this.scrollY / this.cellHeight);
        const endRow = Math.min(this.totalRows, Math.ceil((this.scrollY + viewportHeight) / this.cellHeight));

        const visibleCols = Math.ceil(viewportWidth / this.cellWidth) + 1;
        const visibleRows = Math.ceil(viewportHeight / this.cellHeight) + 1;
        const visibleCells = visibleCols * visibleRows;

        document.getElementById('visible-count').textContent =
            Math.min(visibleCells, this.totalRows * this.totalCols);

        // Draw background with webgpu
        const commandEncoder = this.device.createCommandEncoder();
        const textureView = this.context.getCurrentTexture().createView();

        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: textureView,
                clearValue: { r: 0.067, g: 0.067, b: 0.067, a: 1 },
                loadOp: 'clear',
                storeOp: 'store'
            }]
        });

        renderPass.setPipeline(this.pipeline);
        renderPass.setBindGroup(0, this.bindGroup);
        renderPass.draw(4, visibleCells);
        renderPass.end();

        this.device.queue.submit([commandEncoder.finish()]);

        // text is drawn on a canvas on top of webgpu background
        this.textCtx.clearRect(0, 0, viewportWidth, viewportHeight);

        for (let row = startRow; row < endRow; row++) {
            for (let col = startCol; col < endCol; col++) {
                const idx = row * this.totalCols + col;
                const value = this.cellData[idx];
                const color = this.cellColors[idx];

                const x = col * this.cellWidth - this.scrollX;
                const y = row * this.cellHeight - this.scrollY;

                const r = (color >> 16) & 0xFF;
                const g = (color >> 8) & 0xFF;
                const b = color & 0xFF;

                this.textCtx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                this.textCtx.fillText(
                    value.toFixed(2),
                    x + 4,
                    y + this.cellHeight / 2
                );
            }
        }

        // basic fps display?
        this.frameCount++;
        const now = performance.now();
        if (now - this.lastFpsTime >= 1000) {
            document.getElementById('fps').textContent = this.frameCount;
            this.frameCount = 0;
            this.lastFpsTime = now;
        }
    }

    setupEventListeners() {
        // select a cell
        this.canvas.addEventListener('click', (e) => {
            if (this.isEditing) return;

            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left + this.scrollX;
            const y = e.clientY - rect.top + this.scrollY;

            const col = Math.floor(x / this.cellWidth);
            const row = Math.floor(y / this.cellHeight);

            if (row >= 0 && row < this.totalRows && col >= 0 && col < this.totalCols) {
                this.selectCell(row, col);
            }
        });

        // edit a cell
        this.canvas.addEventListener('dblclick', (e) => {
            if (this.selectedRow >= 0 && this.selectedCol >= 0) {
                this.startEditing();
            }
        });

        // mouse scroll TODO mobile/touch
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();

            this.scrollX = Math.max(0, Math.min(
                this.scrollX + e.deltaX,
                this.totalCols * this.cellWidth - this.canvas.width / devicePixelRatio
            ));

            this.scrollY = Math.max(0, Math.min(
                this.scrollY + e.deltaY,
                this.totalRows * this.cellHeight - this.canvas.height / devicePixelRatio
            ));

            document.getElementById('scroll-x').textContent = Math.round(this.scrollX);
            document.getElementById('scroll-y').textContent = Math.round(this.scrollY);
            this.updateSelectionOverlay();
        });

        // keyboard nav
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Alt') {
                document.querySelector('.info').classList.add('visible');
                e.preventDefault();
                return;
            }

            if (this.isEditing) {
                if (e.key === 'Enter') {
                    this.finishEditing(true);
                } else if (e.key === 'Escape') {
                    this.finishEditing(false);
                }
                return;
            }

            const scrollSpeed = 200;
            let moved = false;

            switch (e.key) {
                case 'ArrowUp':
                    if (this.selectedRow > 0) {
                        this.selectCell(this.selectedRow - 1, this.selectedCol);
                        this.ensureCellVisible(this.selectedRow, this.selectedCol);
                    } else {
                        this.scrollY = Math.max(0, this.scrollY - scrollSpeed);
                        moved = true;
                    }
                    break;
                case 'ArrowDown':
                    if (this.selectedRow >= 0 && this.selectedRow < this.totalRows - 1) {
                        this.selectCell(this.selectedRow + 1, this.selectedCol);
                        this.ensureCellVisible(this.selectedRow, this.selectedCol);
                    } else {
                        this.scrollY = Math.min(
                            this.totalRows * this.cellHeight - this.canvas.height / devicePixelRatio,
                            this.scrollY + scrollSpeed
                        );
                        moved = true;
                    }
                    break;
                case 'ArrowLeft':
                    if (this.selectedCol > 0) {
                        this.selectCell(this.selectedRow, this.selectedCol - 1);
                        this.ensureCellVisible(this.selectedRow, this.selectedCol);
                    } else {
                        this.scrollX = Math.max(0, this.scrollX - scrollSpeed);
                        moved = true;
                    }
                    break;
                case 'ArrowRight':
                    if (this.selectedCol >= 0 && this.selectedCol < this.totalCols - 1) {
                        this.selectCell(this.selectedRow, this.selectedCol + 1);
                        this.ensureCellVisible(this.selectedRow, this.selectedCol);
                    } else {
                        this.scrollX = Math.min(
                            this.totalCols * this.cellWidth - this.canvas.width / devicePixelRatio,
                            this.scrollX + scrollSpeed
                        );
                        moved = true;
                    }
                    break;
                case 'Enter':
                case 'F2':
                    if (this.selectedRow >= 0 && this.selectedCol >= 0) {
                        this.startEditing();
                    }
                    break;
            }

            if (moved) {
                document.getElementById('scroll-x').textContent = Math.round(this.scrollX);
                document.getElementById('scroll-y').textContent = Math.round(this.scrollY);
                this.updateSelectionOverlay();
            }
        });

        document.addEventListener('keyup', (e) => {
            if (e.key === 'Alt') {
                document.querySelector('.info').classList.remove('visible');
            }
        });
    }

    selectCell(row, col) {
        this.selectedRow = row;
        this.selectedCol = col;

        document.getElementById('selected-cell').textContent = `Row: ${row}, Col: ${col}`;
        this.updateSelectionOverlay();
    }

    updateSelectionOverlay() {
        if (this.selectedRow < 0 || this.selectedCol < 0) {
            if (this.selectionOverlay) {
                this.selectionOverlay.style.display = 'none';
            }
            return;
        }

        if (!this.selectionOverlay) {
            this.selectionOverlay = document.createElement('div');
            this.selectionOverlay.className = 'selected-cell';
            document.querySelector('.container').appendChild(this.selectionOverlay);
        }

        const x = this.selectedCol * this.cellWidth - this.scrollX;
        const y = this.selectedRow * this.cellHeight - this.scrollY;

        const rect = this.canvas.getBoundingClientRect();
        const viewportWidth = rect.width;
        const viewportHeight = rect.height;

        // Check if cell is visible
        if (x >= -this.cellWidth && x < viewportWidth &&
            y >= -this.cellHeight && y < viewportHeight) {
            this.selectionOverlay.style.display = 'block';
            this.selectionOverlay.style.left = x + 'px';
            this.selectionOverlay.style.top = y + 'px';
            this.selectionOverlay.style.width = this.cellWidth + 'px';
            this.selectionOverlay.style.height = this.cellHeight + 'px';
        } else {
            this.selectionOverlay.style.display = 'none';
        }
    }

    ensureCellVisible(row, col) {
        const cellX = col * this.cellWidth;
        const cellY = row * this.cellHeight;

        const rect = this.canvas.getBoundingClientRect();
        const viewportWidth = rect.width;
        const viewportHeight = rect.height;

        if (cellX < this.scrollX) {
            this.scrollX = cellX;
        } else if (cellX + this.cellWidth > this.scrollX + viewportWidth) {
            this.scrollX = cellX + this.cellWidth - viewportWidth;
        }

        if (cellY < this.scrollY) {
            this.scrollY = cellY;
        } else if (cellY + this.cellHeight > this.scrollY + viewportHeight) {
            this.scrollY = cellY + this.cellHeight - viewportHeight;
        }

        document.getElementById('scroll-x').textContent = Math.round(this.scrollX);
        document.getElementById('scroll-y').textContent = Math.round(this.scrollY);
        this.updateSelectionOverlay();
    }

    startEditing() {
        if (this.isEditing) return;

        this.isEditing = true;

        // on-demand input
        this.editor = document.createElement('input');
        this.editor.className = 'cell-editor';
        this.editor.type = 'text';

        const idx = this.selectedRow * this.totalCols + this.selectedCol;
        this.editor.value = this.cellData[idx].toFixed(2);
        const x = this.selectedCol * this.cellWidth - this.scrollX;
        const y = this.selectedRow * this.cellHeight - this.scrollY;

        this.editor.style.left = x + 'px';
        this.editor.style.top = y + 'px';
        this.editor.style.width = this.cellWidth + 'px';
        this.editor.style.height = this.cellHeight + 'px';

        document.querySelector('.container').appendChild(this.editor);
        this.editor.focus();
        this.editor.select();

        // Hide selection overlay while editing
        if (this.selectionOverlay) {
            this.selectionOverlay.style.display = 'none';
        }
    }

    finishEditing(save) {
        if (!this.isEditing || !this.editor) return;

        if (save) {
            const value = parseFloat(this.editor.value);
            if (!isNaN(value)) {
                const idx = this.selectedRow * this.totalCols + this.selectedCol;
                const oldValue = this.cellData[idx];
                this.cellData[idx] = value;

                const change = value - oldValue;
                this.cellColors[idx] = change > 0 ? 0xFF00AA00 : 0xFFAA0000;

                this.device.queue.writeBuffer(this.cellDataBuffer, idx * 4, new Float32Array([value]));
                this.device.queue.writeBuffer(this.cellColorBuffer, idx * 4, new Uint32Array([this.cellColors[idx]]));

                // callback for changes
                if (this.onChanged) {
                    this.onChanged(this.selectedRow, this.selectedCol, value);
                }

            }
        }

        this.editor.parentElement.removeChild(this.editor);
        this.editor = null;
        this.isEditing = false;

        this.updateSelectionOverlay();
    }

    startRenderLoop() {
        document.getElementById("row-count").textContent = this.totalRows;
        document.getElementById("col-count").textContent = this.totalCols;
        document.getElementById("total-count").textContent = this.cellCount;

        const animate = () => {
            this.render();
            requestAnimationFrame(animate);
        };
        animate();
    }

    startUpdateLoop() {
        console.log(`updating a ${this.totalRows} x ${this.totalCols} grid every ${this.updateMs}`);
        setInterval(() => {
            this.updateCellData();
        }, this.updateMs);
    }
}
let tetris_loop = false;
class tetris {
    constructor() {
        this.stageWidth = 10;
        this.stageHeight = 20;
        this.stageCanvas = document.getElementById("stage");
        this.nextCanvas = document.getElementById("next");
        let cellWidth = this.stageCanvas.width / this.stageWidth;
        let cellHeight = this.stageCanvas.height / this.stageHeight;
        this.cellSize = cellWidth < cellHeight ? cellWidth : cellHeight;
        this.stageLeftPadding = (this.stageCanvas.width - this.cellSize * this.stageWidth) / 2;
        this.stageTopPadding = (this.stageCanvas.height - this.cellSize * this.stageHeight) / 2;
        this.blocks = this.createBlocks();
        this.deletedLines = 0;


        this.holdBlock = null;
        this.holdUsed = false;
        this.holdCanvas = document.getElementById("hold");  // キャンバス要素をHTMLに追加する必要があります

        this.lastBlock = null; // 最後に出たブロックを覚えておく変数


        window.onkeydown = (e) => {
            if (tetris_loop == false) {
                if (e.keyCode === 37) {
                    this.moveLeft();
                } else if (e.keyCode === 38) {
                    this.rotate();
                } else if (e.keyCode === 39) {
                    this.moveRight();
                } else if (e.keyCode === 40) {
                    this.fall();
                } else if (e.keyCode === 67) {  // "C"キーをホールドに割り当て
                    this.hold();
                }
            }
        }

        // マウスとタッチの両方のイベントに対して連続実行を行うヘルパー関数
        function addContinuousHandler(buttonId, action, intervalTime) {
            const button = document.getElementById(buttonId);
            let intervalId;

            const startAction = (e) => {
                if (e.type === "touchstart") {
                    // タッチ操作の場合、後続の mouse イベントを防ぐために preventDefault を呼び出す
                    e.preventDefault();
                }
                if (!tetris_loop) {
                    // ボタン押下直後に一回実行
                    action();
                    // intervalTime ごとに実行
                    intervalId = setInterval(() => {
                        if (!tetris_loop) {
                            action();
                        }
                    }, intervalTime);
                }
            };

            const stopAction = (_) => {
                clearInterval(intervalId);
            };

            // マウスイベントのバインド
            button.addEventListener("mousedown", startAction);
            button.addEventListener("mouseup", stopAction);
            button.addEventListener("mouseleave", stopAction);

            // タッチイベントのバインド
            button.addEventListener("touchstart", startAction);
            button.addEventListener("touchend", stopAction);
            button.addEventListener("touchcancel", stopAction);
        }

        // 各ボタンに対して、連続実行のハンドラーを追加
        addContinuousHandler("tetris-move-left-button", () => { this.moveLeft(); }, 150);
        addContinuousHandler("tetris-rotate-button", () => { this.rotate(); }, 150);
        addContinuousHandler("tetris-move-right-button", () => { this.moveRight(); }, 150);
        addContinuousHandler("tetris-fall-button", () => { this.fall(); }, 150);
        addContinuousHandler("tetris-fall-button2", () => { this.fall2(); }, 150);
        addContinuousHandler("tetris-hold-button", () => { this.hold(); }, 150);


    }

    createBlocks() {
        let blocks = [
            {
                shape: [[[-1, 0], [0, 0], [1, 0], [2, 0]],
                [[0, -1], [0, 0], [0, 1], [0, 2]],
                [[-1, 0], [0, 0], [1, 0], [2, 0]],
                [[0, -1], [0, 0], [0, 1], [0, 2]]],
                color: "rgb(0, 255, 255)",
                highlight: "rgb(255, 255, 255)",
                shadow: "rgb(0, 128, 128)"
            },
            {
                shape: [[[0, 0], [1, 0], [0, 1], [1, 1]],
                [[0, 0], [1, 0], [0, 1], [1, 1]],
                [[0, 0], [1, 0], [0, 1], [1, 1]],
                [[0, 0], [1, 0], [0, 1], [1, 1]]],
                color: "rgb(255, 255, 0)",
                highlight: "rgb(255, 255, 255)",
                shadow: "rgb(128, 128, 0)"
            },
            {
                shape: [[[0, 0], [1, 0], [-1, 1], [0, 1]],
                [[-1, -1], [-1, 0], [0, 0], [0, 1]],
                [[0, 0], [1, 0], [-1, 1], [0, 1]],
                [[-1, -1], [-1, 0], [0, 0], [0, 1]]],
                color: "rgb(0, 255, 0)",
                highlight: "rgb(255, 255, 255)",
                shadow: "rgb(0, 128, 0)"
            },
            {
                shape: [[[-1, 0], [0, 0], [0, 1], [1, 1]],
                [[0, -1], [-1, 0], [0, 0], [-1, 1]],
                [[-1, 0], [0, 0], [0, 1], [1, 1]],
                [[0, -1], [-1, 0], [0, 0], [-1, 1]]],
                color: "rgb(255, 0, 0)",
                highlight: "rgb(255, 255, 255)",
                shadow: "rgb(128, 0, 0)"
            },
            {
                shape: [[[-1, -1], [-1, 0], [0, 0], [1, 0]],
                [[0, -1], [1, -1], [0, 0], [0, 1]],
                [[-1, 0], [0, 0], [1, 0], [1, 1]],
                [[0, -1], [0, 0], [-1, 1], [0, 1]]],
                color: "rgb(0, 0, 255)",
                highlight: "rgb(255, 255, 255)",
                shadow: "rgb(0, 0, 128)"
            },
            {
                shape: [[[1, -1], [-1, 0], [0, 0], [1, 0]],
                [[0, -1], [0, 0], [0, 1], [1, 1]],
                [[-1, 0], [0, 0], [1, 0], [-1, 1]],
                [[-1, -1], [0, -1], [0, 0], [0, 1]]],
                color: "rgb(255, 165, 0)",
                highlight: "rgb(255, 255, 255)",
                shadow: "rgb(128, 82, 0)"
            },
            {
                shape: [[[0, -1], [-1, 0], [0, 0], [1, 0]],
                [[0, -1], [0, 0], [1, 0], [0, 1]],
                [[-1, 0], [0, 0], [1, 0], [0, 1]],
                [[0, -1], [-1, 0], [0, 0], [0, 1]]],
                color: "rgb(255, 0, 255)",
                highlight: "rgb(255, 255, 255)",
                shadow: "rgb(128, 0, 128)"
            },
            {
                shape: [[[0, 0], [0, 0], [0, 0], [0, 0]],
                [[0, 1], [-1, 0], [-1, 1], [0, 1]],
                [[-1, 1], [-1, 0], [0, 0], [0, 1]],
                [[0, 0], [0, 0], [0, 1], [0, -1]]],
                color: "rgb(100, 100, 100)",
                highlight: "rgb(255, 255, 255)",
                shadow: "rgb(128, 128, 128)"
            }
        ];
        return blocks;
    }







    hold() {
        if (this.holdUsed) return; // すでにホールドを使ったらスキップ

        this.clear(this.stageCanvas);

        if (this.holdBlock == null) {
            // 初めてホールドする場合
            this.holdBlock = this.currentBlock;
            this.createNewBlock(); // 新しいブロックを出す
        } else {
            // すでにホールドしているブロックと交換
            let temp = this.currentBlock;
            this.currentBlock = this.holdBlock;
            this.holdBlock = temp;
            this.blockX = Math.floor(this.stageWidth / 2 - 2);
            this.blockY = 0;
            this.blockAngle = 0;
        }

        this.holdUsed = true; // このターンでは再度使えないように
        this.refreshStage();
        this.drawHoldBlock();
    }

    drawHoldBlock() {
        this.clear(this.holdCanvas);
        if (this.holdBlock != null) {
            this.drawBlock(this.cellSize * 1.25, this.cellSize, this.holdBlock,
                0, this.holdCanvas);
        }
    }






    drawGhostBlock(x, y, type, angle, canvas) {
        let ghostY = y;
        while (this.checkBlockMove(x, ghostY + 1, type, angle)) {
            ghostY++;
        }

        let context = canvas.getContext("2d");
        context.strokeStyle = "rgba(255, 255, 255, 1)";
        context.lineWidth = 2.5;

        for (let i = 0; i < this.blocks[type].shape[angle].length; i++) {
            let cellX = x + this.blocks[type].shape[angle][i][0];
            let cellY = ghostY + this.blocks[type].shape[angle][i][1];

            let drawX = this.stageLeftPadding + cellX * this.cellSize + 0.5;
            let drawY = this.stageTopPadding + cellY * this.cellSize + 0.5;
            let size = this.cellSize - 1;

            context.strokeRect(drawX, drawY, size, size);
        }
    }






    drawBlock(x, y, type, angle, canvas) {
        let context = canvas.getContext("2d");
        let block = this.blocks[type];
        for (let i = 0; i < block.shape[angle].length; i++) {
            this.drawCell(context,
                x + (block.shape[angle][i][0] * this.cellSize),
                y + (block.shape[angle][i][1] * this.cellSize),
                this.cellSize,
                type);
        }
    }

    drawCell(context, cellX, cellY, cellSize, type) {
        let block = this.blocks[type];
        let adjustedX = cellX + 0.5;
        let adjustedY = cellY + 0.5;
        let adjustedSize = cellSize - 1;
        context.fillStyle = block.color;
        context.fillRect(adjustedX, adjustedY, adjustedSize, adjustedSize);
        context.strokeStyle = block.highlight;
        context.beginPath();
        context.moveTo(adjustedX, adjustedY + adjustedSize);
        context.lineTo(adjustedX, adjustedY);
        context.lineTo(adjustedX + adjustedSize, adjustedY);
        context.stroke();
        context.strokeStyle = block.shadow;
        context.beginPath();
        context.moveTo(adjustedX, adjustedY + adjustedSize);
        context.lineTo(adjustedX + adjustedSize, adjustedY + adjustedSize);
        context.lineTo(adjustedX + adjustedSize, adjustedY);
        context.stroke();
    }

    drawStageGrid() {
        let context = this.stageCanvas.getContext("2d");
        let cols = this.stageWidth;
        let rows = this.stageCanvas.height / this.cellSize;
        context.beginPath();
        for (let i = 0; i <= cols; i++) {
            context.moveTo(i * this.cellSize, 0);
            context.lineTo(i * this.cellSize, this.stageCanvas.height);
        }
        for (let j = 0; j <= rows; j++) {
            context.moveTo(0, j * this.cellSize);
            context.lineTo(this.stageCanvas.width, j * this.cellSize);
        }
        context.strokeStyle = "rgba(255, 255, 255, 0.5)";
        context.lineWidth = 1;
        context.stroke();
    }

    startGame() {
        tetris_loop = false;
        clearTimeout(this.timerID);
        this.timerID = null;  // 再利用のためリセット
        let virtualStage = new Array(this.stageWidth);
        for (let i = 0; i < this.stageWidth; i++) {
            virtualStage[i] = new Array(this.stageHeight).fill(null);
        }
        this.virtualStage = virtualStage;
        this.currentBlock = null;
        this.nextBlock = this.getRandomBlock();
        this.mainLoop();
        this.clearHoldBlock();
    }

    startGame2() {
        tetris_loop = false;
        clearTimeout(this.timerID);
        this.timerID = null;  // 再利用のためリセット
        let virtualStage = new Array(this.stageWidth);
        for (let i = 0; i < this.stageWidth; i++) {
            virtualStage[i] = new Array(this.stageHeight).fill(null);
        }
        this.virtualStage = virtualStage;
        this.currentBlock = null;
        this.nextBlock = this.getRandomBlock();
        this.mainLoop2();
        this.clearHoldBlock();
    }

    startGame3() {
        tetris_loop = false;
        clearTimeout(this.timerID);
        this.timerID = null;  // 再利用のためリセット
        let virtualStage = new Array(this.stageWidth);
        for (let i = 0; i < this.stageWidth; i++) {
            virtualStage[i] = new Array(this.stageHeight).fill(null);
        }
        this.virtualStage = virtualStage;
        this.currentBlock = null;
        this.nextBlock = this.getRandomBlock();
        this.mainLoop3();
        this.clearHoldBlock();
    }

    startGame4() {
        tetris_loop = false;
        clearTimeout(this.timerID);
        this.timerID = null;  // 再利用のためリセット
        let virtualStage = new Array(this.stageWidth);
        for (let i = 0; i < this.stageWidth; i++) {
            virtualStage[i] = new Array(this.stageHeight).fill(null);
        }
        this.virtualStage = virtualStage;
        this.currentBlock = null;
        this.nextBlock = this.getRandomBlock();
        this.mainLoop4();
        this.clearHoldBlock();
    }

    startGame5() {
        tetris_loop = false;
        clearTimeout(this.timerID);
        this.timerID = null;  // 再利用のためリセット
        let virtualStage = new Array(this.stageWidth);
        for (let i = 0; i < this.stageWidth; i++) {
            virtualStage[i] = new Array(this.stageHeight).fill(null);
        }
        this.virtualStage = virtualStage;
        this.currentBlock = null;
        this.nextBlock = this.getRandomBlock();
        this.mainLoop5();
        this.clearHoldBlock();
    }

    mainLoop() {
        if (tetris_loop == false) {
            if (this.currentBlock == null) {
                if (!this.createNewBlock()) {
                    return;
                }
            } else {
                this.fallBlock();
            }
            this.drawStage();
            if (this.currentBlock != null) {
                this.drawGhostBlock(this.blockX, this.blockY, this.currentBlock, this.blockAngle, this.stageCanvas);
                this.drawBlock(this.stageLeftPadding + this.blockX * this.cellSize,
                    this.stageTopPadding + this.blockY * this.cellSize,
                    this.currentBlock, this.blockAngle, this.stageCanvas);
            }
        }
        this.timerID = setTimeout(this.mainLoop.bind(this), 800);
    }

    mainLoop2() {
        if (tetris_loop == false) {
            if (this.currentBlock == null) {
                if (!this.createNewBlock()) {
                    return;
                }
            } else {
                this.fallBlock();
            }
            this.drawStage();
            if (this.currentBlock != null) {
                this.drawGhostBlock(this.blockX, this.blockY, this.currentBlock, this.blockAngle, this.stageCanvas);
                this.drawBlock(this.stageLeftPadding + this.blockX * this.cellSize,
                    this.stageTopPadding + this.blockY * this.cellSize,
                    this.currentBlock, this.blockAngle, this.stageCanvas);
            }
        }
        this.timerID = setTimeout(this.mainLoop2.bind(this), 500);
    }

    mainLoop3() {
        if (tetris_loop == false) {
            if (this.currentBlock == null) {
                if (!this.createNewBlock()) {
                    return;
                }
            } else {
                this.fallBlock();
            }
            this.drawStage();
            if (this.currentBlock != null) {
                this.drawGhostBlock(this.blockX, this.blockY, this.currentBlock, this.blockAngle, this.stageCanvas);
                this.drawBlock(this.stageLeftPadding + this.blockX * this.cellSize,
                    this.stageTopPadding + this.blockY * this.cellSize,
                    this.currentBlock, this.blockAngle, this.stageCanvas);
            }
        }
        this.timerID = setTimeout(this.mainLoop3.bind(this), 250);
    }

    mainLoop4() {
        if (tetris_loop == false) {
            if (this.currentBlock == null) {
                if (!this.createNewBlock()) {
                    return;
                }
            } else {
                this.fallBlock();
            }
            this.drawStage();
            if (this.currentBlock != null) {
                this.drawGhostBlock(this.blockX, this.blockY, this.currentBlock, this.blockAngle, this.stageCanvas);
                this.drawBlock(this.stageLeftPadding + this.blockX * this.cellSize,
                    this.stageTopPadding + this.blockY * this.cellSize,
                    this.currentBlock, this.blockAngle, this.stageCanvas);
            }
        }
        this.timerID = setTimeout(this.mainLoop4.bind(this), 100);
    }

    mainLoop5() {
        if (tetris_loop == false) {
            if (this.currentBlock == null) {
                if (!this.createNewBlock()) {
                    return;
                }
            } else {
                this.fallBlock();
            }
            this.drawStage();
            if (this.currentBlock != null) {
                this.drawGhostBlock(this.blockX, this.blockY, this.currentBlock, this.blockAngle, this.stageCanvas);
                this.drawBlock(this.stageLeftPadding + this.blockX * this.cellSize,
                    this.stageTopPadding + this.blockY * this.cellSize,
                    this.currentBlock, this.blockAngle, this.stageCanvas);
            }
        }
        this.timerID = setTimeout(this.mainLoop5.bind(this), 50);
    }

    createNewBlock() {
        this.currentBlock = this.nextBlock;
        this.nextBlock = this.getRandomBlock();
        this.blockX = Math.floor(this.stageWidth / 2 - 2);
        this.blockY = 0;
        this.blockAngle = 0;
        this.drawNextBlock();
        this.holdUsed = false;  // ←この行を createNewBlock() の return true の前に追加
        if (!this.checkBlockMove(this.blockX, this.blockY, this.currentBlock, this.blockAngle)) {
            let messageElem = document.getElementById("message");
            messageElem.innerText = "GAME OVER";
            return false;
        }
        return true;
    }

    drawNextBlock() {
        this.clear(this.nextCanvas);
        this.drawBlock(this.cellSize * 1.2, this.cellSize, this.nextBlock,
            0, this.nextCanvas);
    }

    getRandomBlock() {
        let newBlock;

        // 最初の1回目は何でもOK
        if (this.lastBlock === null) {
            newBlock = Math.floor(Math.random() * 8);
        } else {
            // 2回目以降は、前回と同じ数値が出ないように再抽選
            do {
                newBlock = Math.floor(Math.random() * 8);
            } while (newBlock === this.lastBlock);
        }

        this.lastBlock = newBlock; // 今回出た数字を記録
        return newBlock;
    }

    fallBlock() {
        if (this.checkBlockMove(this.blockX, this.blockY + 1, this.currentBlock, this.blockAngle)) {
            this.blockY++;
        } else {
            this.fixBlock(this.blockX, this.blockY, this.currentBlock, this.blockAngle);
            this.currentBlock = null;
        }
    }

    checkBlockMove(x, y, type, angle) {
        for (let i = 0; i < this.blocks[type].shape[angle].length; i++) {
            let cellX = x + this.blocks[type].shape[angle][i][0];
            let cellY = y + this.blocks[type].shape[angle][i][1];
            if (cellX < 0 || cellX > this.stageWidth - 1) {
                return false;
            }
            if (cellY > this.stageHeight - 1) {
                return false;
            }
            if (this.virtualStage[cellX][cellY] != null) {
                return false;
            }
        }
        return true;
    }

    fixBlock(x, y, type, angle) {
        for (let i = 0; i < this.blocks[type].shape[angle].length; i++) {
            let cellX = x + this.blocks[type].shape[angle][i][0];
            let cellY = y + this.blocks[type].shape[angle][i][1];
            if (cellY >= 0) {
                this.virtualStage[cellX][cellY] = type;
            }
        }
        for (let y = this.stageHeight - 1; y >= 0;) {
            let filled = true;
            for (let x = 0; x < this.stageWidth; x++) {
                if (this.virtualStage[x][y] == null) {
                    filled = false;
                    break;
                }
            }
            if (filled) {
                for (let y2 = y; y2 > 0; y2--) {
                    for (let x = 0; x < this.stageWidth; x++) {
                        this.virtualStage[x][y2] = this.virtualStage[x][y2 - 1];
                    }
                }
                for (let x = 0; x < this.stageWidth; x++) {
                    this.virtualStage[x][0] = null;
                }

                let linesElem = document.getElementById("lines");
                this.deletedLines++;
                linesElem.innerText = "" + this.deletedLines;

                let linesElem2 = document.getElementById("lines2");

                let storedHighScore = localStorage.getItem('tetris_score');

                // ストレージにスコアが無い場合、または現在のスコアの方が大きい場合
                if (storedHighScore === null || this.deletedLines > parseInt(storedHighScore)) {
                    localStorage.setItem('tetris_score', this.deletedLines);
                    linesElem2.innerText = linesElem.textContent;
                }

            } else {
                y--;
            }
        }
    }

    drawStage() {
        this.clear(this.stageCanvas);
        this.drawStageGrid();
        let context = this.stageCanvas.getContext("2d");
        for (let x = 0; x < this.virtualStage.length; x++) {
            for (let y = 0; y < this.virtualStage[x].length; y++) {
                if (this.virtualStage[x][y] != null) {
                    this.drawCell(context,
                        this.stageLeftPadding + (x * this.cellSize),
                        this.stageTopPadding + (y * this.cellSize),
                        this.cellSize,
                        this.virtualStage[x][y]);
                }
            }
        }
    }

    moveLeft() {
        if (this.checkBlockMove(this.blockX - 1, this.blockY, this.currentBlock, this.blockAngle)) {
            this.blockX--;
            this.refreshStage();
        }
    }

    moveRight() {
        if (this.checkBlockMove(this.blockX + 1, this.blockY, this.currentBlock, this.blockAngle)) {
            this.blockX++;
            this.refreshStage();
        }
    }

    rotate() {
        let newAngle;
        if (this.blockAngle < 3) {
            newAngle = this.blockAngle + 1;
        } else {
            newAngle = 0;
        }
        if (this.checkBlockMove(this.blockX, this.blockY, this.currentBlock, newAngle)) {
            this.blockAngle = newAngle;
            this.refreshStage();
        }
    }

    fall() {
        if (this.checkBlockMove(this.blockX, this.blockY + 1, this.currentBlock, this.blockAngle)) {
            this.blockY++;
            this.refreshStage();
        }
    }

    fall2() {
        while (this.checkBlockMove(this.blockX, this.blockY + 1, this.currentBlock, this.blockAngle)) {
            this.blockY++;
            this.refreshStage();
        }
    }

    refreshStage() {
        this.clear(this.stageCanvas);
        this.drawStage();
        this.drawGhostBlock(this.blockX, this.blockY, this.currentBlock, this.blockAngle, this.stageCanvas);
        this.drawBlock(this.stageLeftPadding + this.blockX * this.cellSize,
            this.stageTopPadding + this.blockY * this.cellSize,
            this.currentBlock, this.blockAngle, this.stageCanvas);
    }

    clearHoldBlock() {
        this.holdBlock = null;
        this.clear(this.holdCanvas);
    }


    clear(canvas) {
        let context = canvas.getContext("2d");
        context.fillStyle = "rgb(0, 0, 0)";
        context.fillRect(0, 0, canvas.width, canvas.height);
    }

    reset() {
        clearTimeout(this.mainLoop.bind(this));
        clearTimeout(this.mainLoop2.bind(this));
        clearTimeout(this.mainLoop3.bind(this));
        clearTimeout(this.mainLoop4.bind(this));
        this.stageWidth = 10;
        this.stageHeight = 20;
        this.stageCanvas = document.getElementById("stage");
        this.nextCanvas = document.getElementById("next");
        let cellWidth = this.stageCanvas.width / this.stageWidth;
        let cellHeight = this.stageCanvas.height / this.stageHeight;
        this.cellSize = cellWidth < cellHeight ? cellWidth : cellHeight;
        this.stageLeftPadding = (this.stageCanvas.width - this.cellSize * this.stageWidth) / 2;
        this.stageTopPadding = (this.stageCanvas.height - this.cellSize * this.stageHeight) / 2;
        this.deletedLines = 100;
        this.deletedLines2 = 100;
    }

}


tetris = new tetris();

function tetris_stop() {
    if (tetris_loop == false) {
        tetris_loop = true;
        document.querySelector('.tetstop_text').textContent = "停止中"
    } else {
        tetris_loop = false;
        document.querySelector('.tetstop_text').textContent = ""
    }
}

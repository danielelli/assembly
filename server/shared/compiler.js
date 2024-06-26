const OPERATION_BITS = 4;
const OPERAND_FLAGS_BITS = 2;
const OPERAND_BITS = 12;

const thirtyTwo = OPERATION_BITS + (OPERAND_FLAGS_BITS + OPERAND_BITS) * 2;
if (thirtyTwo != 32) {
    throw new Exception(`OPERATION_BITS + (OPERAND_FLAGS_BITS + OPERAND_BITS) * 2 = ${thirtyTwo} != 32`);
}

const OPERAND_MASK = ((1 << OPERAND_BITS) - 1);
const OPERATION_MASK = ((1 << OPERATION_BITS) - 1);
const OPERAND_FLAGS_MASK = ((1 << OPERAND_FLAGS_BITS) - 1);
const OPERAND_SIGN_MASK = 1 << (OPERAND_BITS - 1);

const OPERATION_SHIFT = 32 - OPERATION_BITS;
const OPERAND_A_FLAGS_SHIFT = OPERATION_SHIFT - OPERAND_FLAGS_BITS;
const OPERAND_A_SHIFT = OPERAND_A_FLAGS_SHIFT - OPERAND_BITS;
const OPERAND_B_FLAGS_SHIFT = OPERAND_A_SHIFT - OPERAND_FLAGS_BITS;
const OPERAND_B_SHIFT = OPERAND_B_FLAGS_SHIFT - OPERAND_BITS;

module.exports.OPERAND_MASK = OPERAND_MASK;
module.exports.OPERATION_MASK = OPERATION_MASK;
module.exports.OPERAND_FLAGS_MASK = OPERAND_FLAGS_MASK;
module.exports.OPERATION_BITS = OPERATION_BITS;

module.exports.OPERATION_SHIFT = OPERATION_SHIFT;
module.exports.OPERAND_A_FLAGS_SHIFT = OPERAND_A_FLAGS_SHIFT;
module.exports.OPERAND_A_SHIFT = OPERAND_A_SHIFT;
module.exports.OPERAND_B_FLAGS_SHIFT = OPERAND_B_FLAGS_SHIFT;
module.exports.OPERAND_B_SHIFT = OPERAND_B_SHIFT;

module.exports.OPERAND_BITS = OPERAND_BITS;

module.exports.compile = compile;
module.exports.getSignedXBitsValue = getSignedXBitsValue;


function compile(tokenList) {
    const instructions = [];
    for (i in tokenList) {
        if (tokenList[i].isInstruction) {
            instructions.push(tokenList[i]);
        }
    }

    const programBuffer = Buffer.alloc(4 * instructions.length);

    for (i in instructions) {
        if (instructions[i].isError) {
            throw Exception("Invalid instruction passed to compiler");
        }

        programBuffer.writeInt32LE(compileInstruction(instructions[i]), i * 4);
    }

    return programBuffer;
}

function getSignedXBitsValue(value) {
    if ((value & OPERAND_SIGN_MASK) == OPERAND_SIGN_MASK) {
        value = value - (OPERAND_SIGN_MASK << 1);
    }

    return value;
}

function compileInstruction(token) {
    let val = 0;
    val |= (token.operation & OPERATION_MASK) << OPERATION_SHIFT;

    if (token.arguments.length > 0) {
        val |= (token.arguments[0].depth & OPERAND_FLAGS_MASK) << OPERAND_A_FLAGS_SHIFT;
        val |= (token.arguments[0].value & OPERAND_MASK) << OPERAND_A_SHIFT;
    }

    if (token.arguments.length > 1) {
        val |= (token.arguments[1].depth & OPERAND_FLAGS_MASK) << OPERAND_B_FLAGS_SHIFT;
        val |= (token.arguments[1].value & OPERAND_MASK) << OPERAND_B_SHIFT;
    }

    if (token.operation == 0) {
        // If data, sign
        val = getSignedXBitsValue(val);
    }

    return val;
}
// Shadcn UI Card Component (ES5/jQuery adaptation)
class Card {
    constructor(element, options = {}) {
        this.element = element;
        this.options = {
            variant: 'default',
            padding: 'default',
            ...options
        };
        this.init();
    }

    init() {
        this.element.classList.add('card');
        this.applyVariant();
        this.applyPadding();
    }

    applyVariant() {
        const variants = {
            default: 'card-default',
            outlined: 'card-outlined',
            elevated: 'card-elevated'
        };
        
        const variantClass = variants[this.options.variant] || variants.default;
        this.element.classList.add(variantClass);
    }

    applyPadding() {
        const paddings = {
            none: 'card-p-0',
            sm: 'card-p-sm',
            default: 'card-p-default',
            lg: 'card-p-lg'
        };
        
        const paddingClass = paddings[this.options.padding] || paddings.default;
        this.element.classList.add(paddingClass);
    }

    static create(selector, options) {
        const elements = document.querySelectorAll(selector);
        elements.forEach(element => new Card(element, options));
    }
}

// Card sub-components
class CardHeader {
    constructor(element) {
        this.element = element;
        this.element.classList.add('card-header');
    }

    static create(selector) {
        const elements = document.querySelectorAll(selector);
        elements.forEach(element => new CardHeader(element));
    }
}

class CardContent {
    constructor(element) {
        this.element = element;
        this.element.classList.add('card-content');
    }

    static create(selector) {
        const elements = document.querySelectorAll(selector);
        elements.forEach(element => new CardContent(element));
    }
}

class CardFooter {
    constructor(element) {
        this.element = element;
        this.element.classList.add('card-footer');
    }

    static create(selector) {
        const elements = document.querySelectorAll(selector);
        elements.forEach(element => new CardFooter(element));
    }
}

// Export for use
window.Card = Card;
window.CardHeader = CardHeader;
window.CardContent = CardContent;
window.CardFooter = CardFooter;